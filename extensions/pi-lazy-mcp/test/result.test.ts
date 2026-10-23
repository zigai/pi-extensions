import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import type { CallToolResult } from "@earendil-works/pi-mcp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Value } from "typebox/value";

import { mcpResultSchema, toolResult } from "../src/result.ts";

const directories: string[] = [];
afterEach(async () => {
    vi.unstubAllEnvs();

    for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});

describe("MCP result projection", () => {
    it("wraps server schemas while preserving local references and literal reference data", () => {
        const serverSchema = {
            type: "object",
            properties: {
                count: { $ref: "#/$defs/Count" },
                tag: { const: { $ref: "#/$defs/Count" } },
                $ref: { type: "string" },
            },
            required: ["count", "tag"],
            $defs: { Count: { type: "integer" } },
        };
        const schema = mcpResultSchema(serverSchema);
        expect(
            Value.Check(schema, {
                content: [],
                structuredContent: {
                    count: 2,
                    tag: { $ref: "#/$defs/Count" },
                    $ref: "field value",
                },
            }),
        ).toBe(true);

        expect(
            Value.Check(schema, {
                content: [],
                structuredContent: { count: "wrong", tag: { $ref: "#/$defs/Count" } },
            }),
        ).toBe(false);

        expect(Value.Check(schema, { count: 2, tag: { $ref: "#/$defs/Count" } })).toBe(false);
        expect(serverSchema.properties.count.$ref).toBe("#/$defs/Count");
    });

    it("keeps resource-local references inside an identified server schema", () => {
        const schema = mcpResultSchema({
            $id: "https://schemas.example.invalid/count",
            type: "object",
            properties: { count: { $ref: "#/$defs/Count" } },
            required: ["count"],
            $defs: { Count: { type: "integer" } },
        });
        expect(Value.Check(schema, { content: [], structuredContent: { count: 2 } })).toBe(true);
        expect(Value.Check(schema, { content: [], structuredContent: { count: "wrong" } })).toBe(
            false,
        );
    });

    it("declares complete image and error envelopes without a server output schema", async () => {
        const image: CallToolResult = {
            content: [{ type: "image", data: "c2FtcGxl", mimeType: "image/png" }],
        };
        const result = await toolResult(image);
        expect(result.structuredContent).toEqual(image);
        expect(Value.Check(mcpResultSchema(), result.structuredContent)).toBe(true);
        expect(
            Value.Check(mcpResultSchema(), {
                content: [],
                structuredContent: [1, null],
                isError: true,
            }),
        ).toBe(true);
    });

    it("bounds aggregate text while retaining complete text, images, and structured values", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".output-test-"));
        directories.push(directory);
        vi.stubEnv("PI_CODING_AGENT_DIR", directory);
        const first = "first sample ".repeat(3000);
        const second = "second sample ".repeat(3000);
        const original: CallToolResult = {
            content: [
                { type: "text", text: first },
                { type: "image", data: "c2FtcGxl", mimeType: "image/png" },
                { type: "text", text: second },
            ],
            structuredContent: { complete: true },
            _meta: { private: "server metadata" },
        };
        const result = await toolResult(original);
        const preview = result.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
        expect(Buffer.byteLength(preview)).toBeLessThan(DEFAULT_MAX_BYTES + 1024);
        expect(result.content.some((block) => block.type === "image")).toBe(true);
        expect(result.structuredContent).toEqual({
            content: [
                { type: "text", text: first },
                { type: "image", data: "c2FtcGxl", mimeType: "image/png" },
                { type: "text", text: second },
            ],
            structuredContent: { complete: true },
        });

        expect(original.content[0]).toEqual({ type: "text", text: first });
        expect(original._meta).toEqual({ private: "server metadata" });
        const output = join(directory, "tool-output", "pi-lazy-mcp");
        const paths = await readdir(output);
        expect(paths).toHaveLength(1);
        const path = paths.at(0);
        if (path === undefined) throw new Error("Missing complete text");

        const saved = await readFile(join(output, path), "utf8");
        expect(saved).toContain(first);
        expect(saved).toContain(second);
        expect(preview).toContain(join(output, path));
    });

    it("keeps short error results and their content order", async () => {
        const result = await toolResult({
            isError: true,
            content: [
                { type: "text", text: "first" },
                { type: "image", data: "c2FtcGxl", mimeType: "image/png" },
                { type: "text", text: "second" },
            ],
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual({
            isError: true,
            content: [
                { type: "text", text: "first" },
                { type: "image", data: "c2FtcGxl", mimeType: "image/png" },
                { type: "text", text: "second" },
            ],
        });

        expect(result.content.map((block) => block.type)).toEqual(["text", "image", "text"]);
        expect(
            result.content.filter((block) => block.type === "text").map((block) => block.text),
        ).toEqual(["first", "second"]);
    });
});
