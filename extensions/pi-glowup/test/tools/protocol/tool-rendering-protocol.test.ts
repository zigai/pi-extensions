import { describe, expect, it } from "vitest";
import { renderProtocolNode } from "../../../src/tools/protocol/node-renderer.ts";
import type { GlowupRenderTheme } from "../../../src/rendering/theme.ts";
import { jsonValueParser, type JsonValue } from "../../../src/json-value.ts";
import {
    call,
    code,
    output,
    decodeGlowupNode,
    list,
    mutation,
    stack,
    summary,
    text,
    withGlowupRendering,
    type GlowupInline,
    type GlowupMutationFile,
    type GlowupMutationLine,
    type GlowupNode,
} from "../../../src/tools/protocol/contract.ts";

describe("Glowup tool-rendering protocol", () => {
    it("attaches passive rendering metadata without mutating the definition", () => {
        const definition = { name: "demo" };
        const rendering = {
            version: 3,
            parseArgs(value: JsonValue) {
                return jsonValueParser.parse(value);
            },
            renderCall() {
                return call({ static: "Demo" });
            },
        } as const;

        const tool = withGlowupRendering(definition, rendering);

        expect(tool).toEqual({ name: "demo", glowupRendering: rendering });
        expect(definition).toEqual({ name: "demo" });
    });

    it("decodes the public composition without retaining caller-owned collections", () => {
        const children: GlowupNode[] = [text("first")];
        const node = stack(children);
        const decoded = decodeGlowupNode(node);
        children.push(list(["second"]));

        expect(decoded).toEqual(stack([text("first")]));

        // Test summary rows and inline styling object isolation
        const mutableInline = {
            kind: "text" as const,
            text: "mutable label",
            tone: "accent" as const,
        };

        const rows: Array<{ label: GlowupInline; value: GlowupInline }> = [
            { label: mutableInline, value: "val" },
        ];

        const summaryNode = summary(rows);
        const decodedSummary = decodeGlowupNode(summaryNode);
        rows.push({ label: "extra", value: "extraVal" });
        mutableInline.text = "MUTATED LABEL";
        expect(decodedSummary).toEqual(
            summary([
                {
                    label: { kind: "text", text: "mutable label", tone: "accent" },
                    value: "val",
                },
            ]),
        );

        // Test mutation file and line collection isolation
        const mutableLine = { kind: "addition" as const, text: "add line" };
        const lines: GlowupMutationLine[] = [mutableLine];
        const files: GlowupMutationFile[] = [{ path: "a.ts", lines, added: 1, removed: 0 }];
        const mutationNode = mutation({ static: "Patch" }, files);
        const decodedMutation = decodeGlowupNode(mutationNode);
        lines.push({ kind: "deletion", text: "del line" });
        files.push({ path: "b.ts", lines: [], added: 0, removed: 0 });
        mutableLine.text = "MUTATED LINE";
        expect(decodedMutation).toEqual(
            mutation({ static: "Patch" }, [
                {
                    path: "a.ts",
                    lines: [{ kind: "addition", text: "add line" }],
                    added: 1,
                    removed: 0,
                },
            ]),
        );
    });

    it("keeps nested decoded and rendered snapshots isolated from producer edits and over-budget appends", () => {
        type MutableInline = {
            -readonly [Key in keyof Exclude<GlowupInline, string>]: Exclude<
                GlowupInline,
                string
            >[Key];
        };

        const label: MutableInline = {
            kind: "text",
            text: "Rows",
            tone: "accent",
            bold: true,
        };
        const value: MutableInline = {
            kind: "text",
            text: "one",
            tone: "error",
            bold: true,
        };
        const row = { label, value };
        const rows = [row];
        const line = { kind: "addition" as const, text: "accepted line", newLine: 1 };
        const lines = [line];
        const file = {
            path: "accepted.txt",
            previousPath: "old.txt",
            lines,
            added: 1,
            removed: 0,
            countsKnown: true,
        };
        const files = [file];
        const labels = { static: "Patch", completed: "Patched" };
        const syntax = { language: "text", path: "accepted.txt" };
        const preview = {
            mode: "head" as const,
            collapsedLines: 2,
            expandedLines: 4,
            expandable: true,
        };

        const children: GlowupNode[] = [
            summary(rows),
            mutation(labels, files),
            code("code body", { title: label, syntax, preview }),
            output("output body", { syntax, preview }),
            list([value], preview),
        ];

        const source = call(labels, { body: stack(children), preview });
        const limits = {
            maxDepth: 8,
            maxNodes: 100,
            maxCollectionItems: 20,
            maxTextCharacters: 500,
        };
        const decoded = decodeGlowupNode(source, limits);
        expect(decoded).toBeDefined();

        if (decoded === undefined) throw new Error("Valid snapshot rejected");

        const accepted = structuredClone(source);
        const theme: GlowupRenderTheme = {
            fg: (token, content) =>
                token === "accent" || token === "error"
                    ? `<${token}>${content}</${token}>`
                    : content,
            bg: (_token, content) => content,
            bold: (content) => `<b>${content}</b>`,
        };
        const context = {
            args: {},
            toolCallId: "snapshot",
            executionStarted: true,
            argsComplete: true,
            isPartial: false,
            expanded: true,
            showImages: false,
            isError: false,
        };
        const renderSnapshot = () =>
            renderProtocolNode(decoded, theme, context, "static").render(500).join("\n");
        const transcript = renderSnapshot();
        expect(transcript).toContain("<b><accent>Rows</accent></b>");
        expect(transcript).toContain("<b><error>one</error></b>");
        expect(transcript).toContain("accepted.txt");
        expect(transcript).toContain("accepted line");

        label.text = "changed label";
        label.tone = "error";
        label.bold = false;
        value.text = "changed value";
        value.tone = "accent";
        value.bold = false;
        row.value = { kind: "text", text: "replacement", tone: "default", bold: false };
        line.text = "changed line";
        line.newLine = 99;
        file.path = "changed.txt";
        file.previousPath = "changed-old.txt";
        file.added = 99;
        file.removed = 98;
        file.countsKnown = false;
        labels.static = "Changed";
        labels.completed = "Changed completed";
        syntax.language = "javascript";
        syntax.path = "changed.js";
        preview.collapsedLines = 1;
        preview.expandedLines = 1;
        preview.expandable = false;
        rows.push(
            ...Array.from({ length: limits.maxCollectionItems + 1 }, () => ({ label, value })),
        );

        lines.push({
            kind: "addition",
            text: "x".repeat(limits.maxTextCharacters + 1),
            newLine: 2,
        });

        files.push({ ...file, path: "appended.txt" });
        children.push(text("appended child"));

        expect(decodeGlowupNode(source, limits)).toBeUndefined();
        expect(decoded).toEqual(accepted);

        // Construct a fresh component so renderer memoization cannot mask attached producer data.
        expect(renderSnapshot()).toBe(transcript);
    });

    it("decodes bounded semantic mutation files and line coordinates", () => {
        const node = mutation(
            { static: "Patch", running: "Patching", completed: "Patched" },
            [
                {
                    path: "src/new.ts",
                    previousPath: "src/old.ts",
                    lines: [
                        { kind: "deletion", text: "old", oldLine: 4 },
                        { kind: "addition", text: "new", newLine: 4 },
                    ],
                    added: 1,
                    removed: 1,
                },
            ],
            { patch: "--- a/src/old.ts\n+++ b/src/new.ts\n@@ -4 +4 @@\n-old\n+new\n" },
        );

        expect(decodeGlowupNode(node)).toEqual(node);
        expect(
            decodeGlowupNode({
                ...node,
                files: [{ ...node.files[0], lines: [{ kind: "addition", text: "x", newLine: 0 }] }],
            }),
        ).toBeUndefined();
    });

    it("bounds mutation files and rows as one collection", () => {
        const node = mutation({ static: "Patch" }, [
            {
                path: "a.ts",
                lines: [
                    { kind: "addition", text: "a" },
                    { kind: "addition", text: "b" },
                ],
                added: 2,
                removed: 0,
            },
        ]);

        expect(
            decodeGlowupNode(node, {
                maxDepth: 8,
                maxNodes: 100,
                maxCollectionItems: 2,
                maxTextCharacters: 100,
            }),
        ).toBeUndefined();
    });

    it("rejects node graphs beyond depth, breadth, node, and text limits", () => {
        const deep = stack([stack([stack([text("leaf")])])]);
        const broad = list(["a", "b", "c"]);
        const manyNodes = stack([text("a"), text("b"), text("c")]);
        const largeText = text("12345");

        expect(
            decodeGlowupNode(deep, {
                maxDepth: 1,
                maxNodes: 100,
                maxCollectionItems: 100,
                maxTextCharacters: 100,
            }),
        ).toBeUndefined();

        expect(
            decodeGlowupNode(broad, {
                maxDepth: 8,
                maxNodes: 100,
                maxCollectionItems: 2,
                maxTextCharacters: 100,
            }),
        ).toBeUndefined();

        expect(
            decodeGlowupNode(manyNodes, {
                maxDepth: 8,
                maxNodes: 3,
                maxCollectionItems: 100,
                maxTextCharacters: 100,
            }),
        ).toBeUndefined();

        expect(
            decodeGlowupNode(largeText, {
                maxDepth: 8,
                maxNodes: 100,
                maxCollectionItems: 100,
                maxTextCharacters: 4,
            }),
        ).toBeUndefined();
    });
});

describe("bounded protocol snapshot traversal", () => {
    const limits = { maxDepth: 8, maxNodes: 100, maxCollectionItems: 4, maxTextCharacters: 100 };

    it("rejects cycles without revisiting their fields, but accepts shared acyclic children", () => {
        let reads = 0;
        const cyclic = {
            kind: "call" as const,
            labels: { static: "Cycle" },
            get body(): GlowupNode {
                reads++;
                return cyclic;
            },
        };
        expect(
            decodeGlowupNode(cyclic, { ...limits, maxDepth: Number.MAX_SAFE_INTEGER }),
        ).toBeUndefined();

        expect(reads).toBe(1);
        const shared = text({ kind: "text", text: "shared", tone: "accent" });
        expect(decodeGlowupNode(stack([shared, shared]), limits)).toEqual(stack([shared, shared]));
    });

    it("rejects oversized collections without reading an element or invoking their iterator", () => {
        let elementReads = 0;
        const oversized = Array.from({ length: 5 }, () => text("unused"));
        Object.defineProperty(oversized, "0", {
            get() {
                elementReads++;
                throw new Error("must not visit");
            },
        });
        Object.defineProperty(oversized, Symbol.iterator, {
            get() {
                throw new Error("must not iterate");
            },
        });

        for (const node of [
            { kind: "stack", children: oversized },
            { kind: "list", items: oversized },
            { kind: "summary", rows: oversized },
            { kind: "mutation", labels: { static: "Patch" }, files: oversized },
            {
                kind: "mutation",
                labels: { static: "Patch" },
                files: [{ path: "a", added: 0, removed: 0, lines: oversized }],
            },
        ])
            expect(decodeGlowupNode(node, limits)).toBeUndefined();

        expect(elementReads).toBe(0);
    });

    it("stops before reading descendants beyond node or depth budgets and text beyond the first excess", () => {
        let reads = 0;
        const unreachable = {
            get kind() {
                reads++;
                throw new Error("must not visit");
            },
        };
        expect(
            decodeGlowupNode(
                { kind: "stack", children: [unreachable] },
                { ...limits, maxDepth: 0 },
            ),
        ).toBeUndefined();

        expect(
            decodeGlowupNode(
                { kind: "stack", children: [unreachable] },
                { ...limits, maxNodes: 1 },
            ),
        ).toBeUndefined();

        expect(
            decodeGlowupNode(
                { kind: "stack", children: [text("x".repeat(101)), unreachable] },
                limits,
            ),
        ).toBeUndefined();

        expect(reads).toBe(0);
    });

    it("validates the first captured getter values, ignores unknown fields, and detaches shared metadata", () => {
        const reads = new Map<string, number>();

        function first<Value>(key: string, value: Value): Value {
            const count = (reads.get(key) ?? 0) + 1;
            reads.set(key, count);

            if (count !== 1) throw new Error(`Repeated ${key} read`);
            return value;
        }

        const inline = {
            get kind() {
                return first("kind", "text");
            },
            get text() {
                return first("text", "accepted");
            },
            get tone() {
                return first("tone", "accent");
            },
            get bold() {
                return first("bold", true);
            },
            get ignored() {
                throw new Error("unknown field read");
            },
        };
        const preview = {
            mode: "head" as const,
            collapsedLines: 2.9,
            expandedLines: 4.8,
            expandable: false,
        };
        const source = {
            kind: "list",
            items: [inline, { kind: "text", text: inline }],
            preview,
            ignored: inline,
        };
        const decoded = decodeGlowupNode(source, limits);
        const accepted = { kind: "text", text: "accepted", tone: "accent", bold: true };
        expect(decoded).toEqual({
            kind: "list",
            items: [accepted, { kind: "text", text: accepted }],
            preview: { mode: "head", collapsedLines: 2, expandedLines: 4, expandable: false },
        });

        expect([...reads.values()]).toEqual([1, 1, 1, 1]);
        preview.collapsedLines = 99;
        expect(decoded).toMatchObject({ preview: { collapsedLines: 2 } });
        expect(
            decodeGlowupNode({
                kind: "text",
                get text() {
                    throw new Error("producer failed");
                },
            }),
        ).toBeUndefined();
        let changingReads = 0;
        expect(
            decodeGlowupNode({
                kind: "text",
                get text() {
                    return ++changingReads === 1 ? 42 : "valid later";
                },
            }),
        ).toBeUndefined();

        expect(changingReads).toBe(1);
    });

    it("captures array length and indexed getters once even when the producer changes them", () => {
        let lengthReads = 0;
        let itemReads = 0;
        const items = new Proxy(["accepted"], {
            get(target, key) {
                if (key === "length") return ++lengthReads === 1 ? 1 : 1000;

                if (key === "0") {
                    itemReads++;
                    return target[0];
                }

                throw new Error(`Unexpected array access: ${String(key)}`);
            },
        });
        expect(decodeGlowupNode({ kind: "list", items }, limits)).toEqual(list(["accepted"]));
        expect(lengthReads).toBe(1);
        expect(itemReads).toBe(1);
    });
});
