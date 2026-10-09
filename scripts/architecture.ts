import { existsSync, globSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { API, type Program } from "typescript/unstable/sync";

import {
    isWithinDirectory,
    exportTargets,
    type WorkspacePackage,
    type WorkspacePackages,
} from "./workspace-packages.ts";

type ModuleImport = {
    readonly specifier: string | undefined;
    readonly runtime: boolean;
    readonly line: number;
};

type SourceModule = {
    readonly imports: readonly ModuleImport[];
};

function hasRuntimeBindings(clause: ts.ImportClause): boolean {
    if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return false;
    if (clause.name !== undefined || clause.namedBindings === undefined) return true;
    if (ts.isNamespaceImport(clause.namedBindings)) return true;
    return (
        clause.namedBindings.elements.length === 0 ||
        clause.namedBindings.elements.some((element) => !element.isTypeOnly)
    );
}

function readSourceModule(program: Program, file: string): SourceModule {
    const candidate = program.getSourceFile(file);
    if (candidate === undefined)
        throw new Error(`Source file is outside the TypeScript project: ${file}`);

    const source = candidate;
    const imports: ModuleImport[] = [];

    function record(node: ts.Node, expression: ts.Expression | undefined, runtime: boolean): void {
        let specifier: string | undefined;
        if (
            expression !== undefined &&
            (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
        ) {
            specifier = expression.text;
        }

        imports.push({
            specifier,
            runtime,
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        });
    }

    function visit(node: ts.Node): void {
        if (ts.isImportDeclaration(node)) {
            let runtime = true;
            if (node.importClause !== undefined) runtime = hasRuntimeBindings(node.importClause);
            record(node, node.moduleSpecifier, runtime);
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
            let runtime = !node.isTypeOnly;
            if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
                runtime &&= node.exportClause.elements.some((element) => !element.isTypeOnly);
            }

            record(node, node.moduleSpecifier, runtime);
        } else if (
            ts.isImportEqualsDeclaration(node) &&
            ts.isExternalModuleReference(node.moduleReference)
        ) {
            record(node, node.moduleReference.expression, !node.isTypeOnly);
        } else if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === "require"))
        ) {
            record(node, node.arguments[0], true);
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
            if (ts.isStringLiteral(node.argument.literal))
                record(node, node.argument.literal, false);
        }

        node.forEachChild(visit);
    }

    visit(source);

    return { imports };
}

function packageName(specifier: string): string {
    if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
    return specifier.split("/")[0] ?? specifier;
}

function isLocalImport(specifier: string): boolean {
    return specifier.startsWith(".") || path.isAbsolute(specifier) || specifier.startsWith("file:");
}

function resolveLocalImport(file: string, specifier: string): string | undefined {
    let localSpecifier = specifier;
    if (specifier.startsWith("file:")) localSpecifier = fileURLToPath(specifier);

    const target = path.resolve(path.dirname(file), localSpecifier);
    if (existsSync(target)) return target;

    const extension = path.extname(target);
    if (extension === ".js") {
        const source = `${target.slice(0, -3)}.ts`;
        if (existsSync(source)) return source;
    }

    return undefined;
}

function checkSettingsClosure(
    workspace: WorkspacePackage,
    load: (file: string) => SourceModule,
    report: (file: string, dependency: ModuleImport, message: string) => void,
): void {
    const settings = workspace.manifest.piExtensionSettings;
    if (settings === undefined) return;

    const definition = path.resolve(workspace.directory, settings.definition);
    const visited = new Set<string>();

    const forbidden = new Set([
        path.resolve(workspace.directory, settings.prevalidation),
        ...Object.values(workspace.manifest.exports)
            .flatMap(exportTargets)
            .map((entry) => path.resolve(workspace.directory, entry)),
        ...(workspace.manifest.pi?.extensions ?? []).map((entry) =>
            path.resolve(workspace.directory, entry),
        ),
    ]);

    const visit = (file: string, chain: readonly string[]): void => {
        if (visited.has(file)) return;

        visited.add(file);

        for (const dependency of load(file).imports) {
            if (!dependency.runtime) continue;

            const specifier = dependency.specifier;
            const context = `settings authoring (${chain.map((entry) => path.relative(workspace.directory, entry)).join(" -> ")})`;
            if (specifier === undefined) {
                report(file, dependency, `Unverifiable dynamic runtime import in ${context}`);
            } else if (isLocalImport(specifier)) {
                const target = resolveLocalImport(file, specifier);
                if (target === undefined || !isWithinDirectory(workspace.directory, target)) {
                    report(
                        file,
                        dependency,
                        `Invalid local runtime import ${specifier} in ${context}`,
                    );
                    continue;
                }

                if (forbidden.has(target) || path.basename(target) === "settings.ts") {
                    report(
                        file,
                        dependency,
                        `Runtime import into feature initialization or settings hydration: ${specifier} in ${context}`,
                    );
                } else {
                    visit(target, [...chain, target]);
                }
            } else if (
                packageName(specifier) !== "typebox" &&
                specifier !== "@zigai/pi-extension-settings"
            ) {
                report(
                    file,
                    dependency,
                    `Runtime dependency ${specifier} is not build-safe in ${context}`,
                );
            }
        }
    };

    visit(definition, [definition]);
}

function checkProjectArchitecture(workspaces: WorkspacePackages, program: Program): string[] {
    const diagnostics = new Set<string>();
    const packagesByName = new Map(
        workspaces.packages.map((workspace) => [workspace.manifest.name, workspace]),
    );
    const modules = new Map<string, SourceModule>();
    const load = (file: string): SourceModule => {
        let module = modules.get(file);
        if (module === undefined) {
            module = readSourceModule(program, file);
            modules.set(file, module);
        }

        return module;
    };

    const report = (file: string, dependency: ModuleImport, message: string): void => {
        diagnostics.add(`${path.relative(workspaces.root, file)}:${dependency.line}: ${message}`);
    };

    for (const workspace of workspaces.packages) {
        const manifest = workspace.manifest;
        if (!Object.hasOwn(manifest.exports, ".")) {
            diagnostics.add(`${manifest.name}: the package must export its root explicitly`);
        }

        const files = new Set(
            globSync("src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}", {
                cwd: workspace.directory,
                exclude: ["**/*.test.*", "**/*.spec.*"],
            }),
        );
        for (const entry of workspace.manifest.pi?.extensions ?? []) {
            if (!entry.startsWith("./node_modules/") && !entry.startsWith("./dist/"))
                files.add(entry);
        }
        for (const relative of files) {
            const file = path.resolve(workspace.directory, relative);
            for (const dependency of load(file).imports) {
                const specifier = dependency.specifier;
                if (specifier === undefined) continue;

                if (isLocalImport(specifier)) {
                    const target = resolveLocalImport(file, specifier);
                    if (target === undefined) {
                        report(file, dependency, `Cannot resolve local import ${specifier}`);
                    } else if (!isWithinDirectory(workspace.directory, target)) {
                        report(
                            file,
                            dependency,
                            `Cross-package source import ${specifier}; use a published export`,
                        );
                    }
                    continue;
                }

                if (isBuiltin(specifier)) continue;

                const name = packageName(specifier);
                if (
                    dependency.runtime &&
                    name !== manifest.name &&
                    manifest.dependencies?.[name] === undefined &&
                    manifest.peerDependencies?.[name] === undefined
                ) {
                    report(file, dependency, `Undeclared runtime dependency ${name}`);
                }

                const target = packagesByName.get(name);
                if (target === undefined) continue;

                let exportKey = ".";
                if (specifier !== name) exportKey = `.${specifier.slice(name.length)}`;

                if (
                    !Object.hasOwn(target.manifest.exports, exportKey) ||
                    exportTargets(target.manifest.exports[exportKey] ?? null).length === 0
                ) {
                    report(
                        file,
                        dependency,
                        `Workspace import ${specifier} is not a published export`,
                    );
                }

                if (
                    dependency.runtime &&
                    name !== manifest.name &&
                    manifest.dependencies?.[name] === undefined
                ) {
                    report(
                        file,
                        dependency,
                        `Workspace runtime dependency ${name} must be in dependencies`,
                    );
                }
            }
        }

        checkSettingsClosure(workspace, load, report);
    }

    return [...diagnostics].sort();
}

/** Checks package imports and the complete runtime dependency closure of each settings definition. */
export function checkArchitecture(workspaces: WorkspacePackages): string[] {
    // TypeScript 7 exposes its compiler API under /unstable. Keep that dependency local
    // to this development check; no extension or public package API depends on it.
    const compiler = new API({ cwd: workspaces.root });

    try {
        const config = path.join(workspaces.root, "tsconfig.architecture.json");
        const snapshot = compiler.updateSnapshot({ openProjects: [config] });

        try {
            const project = snapshot.getProject(config);
            if (project === undefined) throw new Error("Unable to open the TypeScript project");
            return checkProjectArchitecture(workspaces, project.program);
        } finally {
            snapshot.dispose();
        }
    } finally {
        compiler.close();
    }
}
