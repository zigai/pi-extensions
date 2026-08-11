import { describe, expect, it } from "vitest";
import {
    call,
    decodeGlowupNode,
    list,
    mutation,
    stack,
    text,
    withGlowupRendering,
    type GlowupNode,
} from "../src/tool-rendering/protocol.ts";

describe("Glowup tool-rendering protocol", () => {
    it("attaches passive rendering metadata without mutating the definition", () => {
        const definition = { name: "demo" };
        const rendering = {
            version: 3,
            parseArgs(value: unknown) {
                return value;
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
