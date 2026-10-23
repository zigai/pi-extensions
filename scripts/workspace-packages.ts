import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
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
    piWorkspace: Type.Object(
        {
            optionalExtensions: Type.Array(Type.String(), { uniqueItems: true }),
            collections: Type.Array(Type.String(), { uniqueItems: true }),
        },
        { additionalProperties: false },
    ),
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
    readonly extensions: readonly WorkspaceExtension[];

    /** Ordered exactly as the root's standard Pi entrypoints. */
    readonly defaultExtensions: readonly WorkspaceExtension[];
    readonly optionalExtensions: readonly WorkspaceExtension[];
    readonly collections: readonly WorkspacePackage[];
};

export function isWithinDirectory(directory: string, file: string): boolean {
    const relative = path.relative(directory, file);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Discovers all extensions; repo grouping metadata never becomes a native Pi selection flag. */
export function discoverWorkspacePackages(root: string, verifyEntries = true): WorkspacePackages {
    const rootValue: unknown = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    if (!Value.Check(rootManifest, rootValue)) throw new Error("Invalid root workspace manifest");

    const manifest = Value.Parse(rootManifest, rootValue);
    const collectionNames = new Set(manifest.piWorkspace.collections);
    const optionalNames = new Set(manifest.piWorkspace.optionalExtensions);
    for (const name of collectionNames) {
        if (optionalNames.has(name))
            throw new Error("A collection workspace cannot also be optional");
    }

    const manifestPaths = globSync(
        manifest.workspaces.map((pattern) => `${pattern}/package.json`),
        { cwd: root },
    ).sort((left, right) => left.localeCompare(right));
    const packages: WorkspacePackage[] = [];
    const byName = new Map<string, WorkspacePackage>();
    const entries = new Map<string, WorkspaceExtension>();

    for (const manifestPath of manifestPaths) {
        const directory = path.resolve(root, path.dirname(manifestPath));
        const value: unknown = JSON.parse(readFileSync(path.join(root, manifestPath), "utf8"));
        if (!Value.Check(workspaceManifest, value)) {
            throw new Error(`${manifestPath} must declare a name and explicit exports`);
        }

        const parsed = Value.Parse(workspaceManifest, value);
        if (byName.has(parsed.name)) throw new Error(`Duplicate workspace package ${parsed.name}`);

        const workspace = { directory, manifest: parsed };
        byName.set(parsed.name, workspace);
        packages.push(workspace);

        for (const entry of parsed.pi?.extensions ?? []) {
            const source = path.resolve(directory, entry);
            if (
                !isWithinDirectory(directory, source) ||
                (verifyEntries && !collectionNames.has(parsed.name) && !existsSync(source))
            ) {
                throw new Error(`${manifestPath} declares an invalid extension entry ${entry}`);
            }

            if (collectionNames.has(parsed.name)) continue;
            if (entries.has(source)) throw new Error(`Duplicate workspace extension ${source}`);

            entries.set(source, { workspace, entry, source });
        }
    }

    if (packages.length === 0) throw new Error("No workspace packages found");

    const collections = manifest.piWorkspace.collections.map((name) => {
        const workspace = byName.get(name);
        if (workspace === undefined) throw new Error(`Unknown collection workspace: ${name}`);
        return workspace;
    });

    for (const name of optionalNames) {
        const workspace = byName.get(name);
        if (workspace === undefined || (workspace.manifest.pi?.extensions.length ?? 0) === 0) {
            throw new Error(`Unknown optional extension workspace: ${name}`);
        }
    }

    const defaultExtensions: WorkspaceExtension[] = [];
    for (const entry of manifest.pi.extensions) {
        const source = path.resolve(root, entry);
        const extension = entries.get(source);
        if (extension === undefined) {
            throw new Error(`Root Pi extension is undeclared or duplicated: ${entry}`);
        }

        if (optionalNames.has(extension.workspace.manifest.name)) {
            throw new Error(`Optional extension is present in the root loadout: ${entry}`);
        }

        defaultExtensions.push(extension);
        entries.delete(source);
    }

    const optionalExtensions: WorkspaceExtension[] = [];
    for (const name of optionalNames) {
        for (const [source, extension] of entries) {
            if (extension.workspace.manifest.name !== name) continue;
            optionalExtensions.push(extension);
            entries.delete(source);
        }
    }

    if (entries.size > 0) {
        throw new Error(
            `Root Pi manifest is missing workspace extensions: ${[...entries.keys()]
                .map((source) => path.relative(root, source))
                .join(", ")}`,
        );
    }

    return {
        root,
        packages,
        extensions: [...defaultExtensions, ...optionalExtensions],
        defaultExtensions,
        optionalExtensions,
        collections,
    };
}

type CollectionResources = Required<
    Pick<Static<typeof workspaceManifest>, "dependencies" | "bundleDependencies" | "pi">
>;

export function collectionResources(
    extensions: readonly WorkspaceExtension[],
): CollectionResources {
    const versions = new Map<string, string>();
    for (const { workspace } of extensions) {
        const { name, version } = workspace.manifest;
        if (version === undefined)
            throw new Error(`Collection requires an independent version for ${name}`);

        versions.set(name, version);
    }

    const ordered = [...versions].sort(([left], [right]) => left.localeCompare(right));

    return {
        dependencies: Object.fromEntries(ordered),
        bundleDependencies: ordered.map(([name]) => name),
        pi: {
            extensions: extensions.map(
                ({ workspace, entry }) =>
                    `./node_modules/${workspace.manifest.name}/${entry.replace(/^\.\//u, "")}`,
            ),
        },
    };
}

/** Validates the generated collection resources against the authoritative default selection. */
export function loadWorkspacePackages(root: string, verifyEntries = true): WorkspacePackages {
    const inventory = discoverWorkspacePackages(root, verifyEntries);
    for (const { manifest } of inventory.collections) {
        const expected = collectionResources(inventory.defaultExtensions);
        if (
            !isDeepStrictEqual(manifest.pi?.extensions, expected.pi.extensions) ||
            !isDeepStrictEqual(manifest.dependencies, expected.dependencies) ||
            manifest.bundleDependencies === undefined ||
            !isDeepStrictEqual(
                [...manifest.bundleDependencies].sort((left, right) => left.localeCompare(right)),
                expected.bundleDependencies,
            )
        ) {
            throw new Error(
                "Collection must match the ordered default extension inventory with exact bundled version pins",
            );
        }
    }

    return inventory;
}
