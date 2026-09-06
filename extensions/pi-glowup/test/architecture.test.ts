import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { readModuleGraph } from "./support/module-graph.ts";

function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const file = join(directory, entry.name);
        return entry.isDirectory() ? sourceFiles(file) : entry.name.endsWith(".ts") ? [file] : [];
    });
}

const graph = readModuleGraph(sourceFiles("src"));
const modulePath = (file: string): string => relative(process.cwd(), file).replaceAll("\\", "/");
const edges = graph.edges.map(({ from, to }) => ({ from: modulePath(from), to: modulePath(to) }));

describe("module ownership", () => {
    it("keeps reusable rendering independent of tools and Pi orchestration", () => {
        expect(
            edges.filter(
                ({ from, to }) =>
                    from.startsWith("src/rendering/") &&
                    /^src\/(?:tools|pi|config|diagnostics)\//u.test(to),
            ),
        ).toEqual([]);
    });

    it("keeps tool features independent of Pi installation and configuration loading", () => {
        expect(
            edges.filter(
                ({ from, to }) =>
                    from.startsWith("src/tools/") && /^src\/(?:pi|config|diagnostics)\//u.test(to),
            ),
        ).toEqual([]);
    });

    it("keeps the generic protocol engine independent of external-tool families", () => {
        expect(
            edges.filter(
                ({ from, to }) =>
                    from.startsWith("src/tools/protocol/") && to.startsWith("src/tools/external/"),
            ),
        ).toEqual([]);
    });

    it("has no dependency cycles, including type-only imports", () => {
        const complete = new Set<string>();
        const stack: string[] = [];
        const cycles: string[][] = [];
        function visit(file: string): void {
            const active = stack.indexOf(file);
            if (active !== -1) {
                cycles.push([...stack.slice(active), file]);
                return;
            }
            if (complete.has(file)) return;
            stack.push(file);
            for (const edge of edges) if (edge.from === file) visit(edge.to);
            stack.pop();
            complete.add(file);
        }
        for (const file of graph.files) visit(modulePath(file));
        expect(cycles).toEqual([]);
    });
});
