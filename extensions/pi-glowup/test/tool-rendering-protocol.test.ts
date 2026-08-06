import { describe, expect, it } from "vitest";
import {
    call,
    decodeGlowupNode,
    list,
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
