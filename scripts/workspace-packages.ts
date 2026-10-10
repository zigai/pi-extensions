import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const extensionManifest = Type.Object({ extensions: Type.Array(Type.String()) });
const exportTarget = Type.Cyclic(
    {
        Target: Type.Union([
            Type.String(),
            Type.Null(),
            Type.Array(Type.Ref("Target")),
            Type.Record(Type.String(), Type.Ref("Target")),
        ]),
    },
    "Target",
);

export type ExportTarget = Static<typeof exportTarget>;

export function exportTargets(target: ExportTarget): string[] {
    if (Value.Check(Type.String(), target)) return [target];
    if (target === null) return [];
    if (Array.isArray(target)) return target.flatMap(exportTargets);
    return Object.values(target).flatMap(exportTargets);
}

export const workspaceManifest = Type.Object({
    name: Type.String(),
    exports: Type.Record(Type.String(), exportTarget),
    version: Type.Optional(Type.String()),
    scripts: Type.Optional(Type.Record(Type.String(), Type.String())),
    piCollection: Type.Optional(Type.Array(Type.String())),
    lintStages: Type.Optional(
        Type.Array(
            Type.Object({
                targets: Type.Array(Type.String()),
            }),
        ),
    ),
    bundleDependencies: Type.Optional(Type.Array(Type.String())),
    dependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
    optionalDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
    peerDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
    pi: Type.Optional(extensionManifest),
    piExtensionSettings: Type.Optional(
        Type.Object({
            definition: Type.String(),
            prevalidation: Type.String(),
            schema: Type.String(),
            readme: Type.String(),
        }),
    ),
});

const rootManifest = Type.Object({
    workspaces: Type.Array(Type.String()),
    pi: extensionManifest,
});

export type WorkspacePackage = {
    readonly directory: string;
    readonly manifest: Static<typeof workspaceManifest>;
};

export type WorkspaceExtension = {
    readonly workspace: WorkspacePackage;
    readonly entry: string;
    readonly source: string;
};

export type WorkspacePackages = {
    readonly root: string;
    readonly packages: readonly WorkspacePackage[];

    /** Ordered exactly as the root Pi manifest, which determines extension loading order. */
    readonly extensions: readonly WorkspaceExtension[];
};

export function isWithinDirectory(directory: string, file: string): boolean {
    const relative = path.relative(directory, file);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Discovers manifests and verifies that the root loads every declared extension exactly once. */
export function loadWorkspacePackages(root: string, verifyEntries = true): WorkspacePackages {
    const rootValue: unknown = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    if (!Value.Check(rootManifest, rootValue)) throw new Error("Invalid root workspace manifest");

    const manifest = Value.Parse(rootManifest, rootValue);
    const manifestPaths = globSync(
        manifest.workspaces.map((pattern) => `${pattern}/package.json`),
        { cwd: root },
    ).sort();
    const packages: WorkspacePackage[] = [];
    const names = new Set<string>();
    const entries = new Map<string, WorkspaceExtension>();

    for (const manifestPath of manifestPaths) {
        const directory = path.resolve(root, path.dirname(manifestPath));
        const value: unknown = JSON.parse(readFileSync(path.join(root, manifestPath), "utf8"));
        if (!Value.Check(workspaceManifest, value)) {
            throw new Error(`${manifestPath} must declare a name and explicit exports`);
        }

        const parsed = Value.Parse(workspaceManifest, value);
        if (names.has(parsed.name)) throw new Error(`Duplicate workspace package ${parsed.name}`);

        names.add(parsed.name);

        const workspace = { directory, manifest: parsed };
        packages.push(workspace);

        for (const entry of parsed.pi?.extensions ?? []) {
            const source = path.resolve(directory, entry);
            if (
                !isWithinDirectory(directory, source) ||
                (verifyEntries && parsed.piCollection === undefined && !existsSync(source))
            ) {
                throw new Error(`${manifestPath} declares an invalid extension entry ${entry}`);
            }

            if (parsed.piCollection !== undefined) continue;

            if (entries.has(source)) throw new Error(`Duplicate workspace extension ${source}`);

            entries.set(source, { workspace, entry, source });
        }
    }

    if (packages.length === 0) throw new Error("No workspace packages found");

    const extensions: WorkspaceExtension[] = [];
    for (const entry of manifest.pi.extensions) {
        const source = path.resolve(root, entry);
        const extension = entries.get(source);
        if (extension === undefined) {
            throw new Error(`Root Pi extension is undeclared or duplicated: ${entry}`);
        }

        extensions.push(extension);
        entries.delete(source);
    }

    if (entries.size > 0) {
        throw new Error(
            `Root Pi manifest is missing workspace extensions: ${[...entries.keys()]
                .map((source) => path.relative(root, source))
                .join(", ")}`,
        );
    }

    for (const workspace of packages) {
        const collection = workspace.manifest.piCollection;
        if (collection === undefined) continue;

        const expected = extensions.map((extension) => extension.workspace.manifest.name);
        if (JSON.stringify(collection) !== JSON.stringify(expected)) {
            throw new Error(
                "The Pi tweaks collection must match the ordered root extension inventory",
            );
        }

        const resources = extensions.map(
            ({ workspace: extensionWorkspace, entry }) =>
                `./node_modules/${extensionWorkspace.manifest.name}/${entry.replace(/^\.\//u, "")}`,
        );
        if (
            JSON.stringify(workspace.manifest.pi?.extensions) !== JSON.stringify(resources) ||
            workspace.manifest.bundleDependencies?.length !== expected.length ||
            expected.some((name) => workspace.manifest.bundleDependencies?.includes(name) !== true)
        ) {
            throw new Error(
                "Collection must bundle and reference each independent extension resource in order",
            );
        }

        for (const extension of extensions) {
            const dependency = extension.workspace.manifest;
            if (
                dependency.version === undefined ||
                workspace.manifest.dependencies?.[dependency.name] !== dependency.version
            ) {
                throw new Error(
                    `Collection must pin ${dependency.name} to its independent workspace version`,
                );
            }
        }
    }

    return { root, packages, extensions };
}
