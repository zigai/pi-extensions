import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";

export type ModuleEdge = { readonly from: string; readonly to: string };

/** Follow runtime and type imports using TypeScript's source resolution. */
export function readModuleGraph(entries: readonly string[]) {
    const visited = new Set<string>();
    const edges: ModuleEdge[] = [];
    const externalImports = new Set<string>();
    const sourceRoot = resolve("src");

    function visit(file: string): void {
        const from = resolve(file);
        if (visited.has(from)) return;
        visited.add(from);

        const source = ts.createSourceFile(
            from,
            readFileSync(from, "utf8"),
            ts.ScriptTarget.Latest,
            true,
        );

        function visitNode(node: ts.Node): void {
            let argument: ts.Node | undefined;
            if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
                argument = node.moduleSpecifier;
            else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
                argument = node.argument.literal;
            else if (ts.isExternalModuleReference(node)) argument = node.expression;
            else if (
                ts.isCallExpression(node) &&
                node.expression.kind === ts.SyntaxKind.ImportKeyword
            ) {
                argument = node.arguments[0];
                if (argument === undefined || !ts.isStringLiteralLike(argument)) {
                    throw new Error(
                        `Dynamic module dependency must be statically resolvable: ${from}`,
                    );
                }
            }

            if (argument !== undefined && ts.isStringLiteralLike(argument)) {
                const specifier = argument.text;
                const resolved = ts.resolveModuleName(
                    specifier,
                    from,
                    {
                        module: ts.ModuleKind.NodeNext,
                        moduleResolution: ts.ModuleResolutionKind.NodeNext,
                        allowImportingTsExtensions: true,
                    },
                    ts.sys,
                ).resolvedModule;
                if (resolved === undefined) {
                    if (specifier.startsWith(".") || isAbsolute(specifier)) {
                        throw new Error(`Unresolved local dependency ${specifier} in ${from}`);
                    }

                    externalImports.add(specifier);
                } else {
                    const to = resolve(resolved.resolvedFileName);
                    const withinSource = relative(sourceRoot, to);
                    if (!withinSource.startsWith("..") && !isAbsolute(withinSource)) {
                        edges.push({ from, to });
                        visit(to);
                    } else externalImports.add(specifier);
                }
            }

            ts.forEachChild(node, visitNode);
        }

        visitNode(source);
    }

    for (const entry of entries) visit(entry);

    return { files: [...visited], edges, externalImports: [...externalImports] };
}
