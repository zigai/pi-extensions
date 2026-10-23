import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    getAgentDir,
    truncateHead,
} from "@earendil-works/pi-coding-agent";
import { toLlmContent, type CallToolResult } from "@earendil-works/pi-mcp";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { jsonValueSchema, type JsonObject } from "./json.ts";

type JsonValue = JsonObject[string];

const schemaDataKeywords = new Set(["const", "enum", "default", "examples"]);

const schemaMapKeywords = new Set([
    "properties",
    "patternProperties",
    "dependentSchemas",
    "dependencies",
    "$defs",
    "definitions",
]);

function isJsonObject(value: JsonValue): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonString(value: JsonValue): value is string {
    return typeof value === "string";
}

function relocateSchema(value: JsonObject, relocatePointers?: boolean): JsonObject;
function relocateSchema(value: JsonValue, relocatePointers?: boolean): JsonValue;
function relocateSchema(value: JsonValue, relocatePointers = true): JsonValue {
    if (Array.isArray(value))
        return value.map((schema) => relocateSchema(schema, relocatePointers));

    if (!isJsonObject(value)) return value;

    const id = value.$id;
    if (id !== undefined && isJsonString(id) && id !== "") relocatePointers = false;

    const relocated: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
        if (
            key === "$ref" &&
            relocatePointers &&
            isJsonString(child) &&
            (child === "#" || child.startsWith("#/"))
        ) {
            relocated[key] = `#/properties/structuredContent${child.slice(1)}`;
        } else if (schemaDataKeywords.has(key)) {
            relocated[key] = child;
        } else if (schemaMapKeywords.has(key) && isJsonObject(child)) {
            relocated[key] = Object.fromEntries(
                Object.entries(child).map(([name, schema]) => [
                    name,
                    relocateSchema(schema, relocatePointers),
                ]),
            );
        } else {
            relocated[key] = relocateSchema(child, relocatePointers);
        }
    }

    return relocated;
}

export function mcpResultSchema(structuredContentSchema?: JsonObject) {
    let structuredSchema: JsonObject = {};
    if (structuredContentSchema !== undefined)
        structuredSchema = relocateSchema(structuredClone(structuredContentSchema));

    return Type.Object(
        {
            content: Type.Array(
                Type.Object(
                    {
                        type: Type.Enum(["text", "image", "audio", "resource_link", "resource"]),
                        text: Type.Optional(Type.String()),
                        data: Type.Optional(Type.String()),
                        mimeType: Type.Optional(Type.String()),
                    },
                    { additionalProperties: true },
                ),
            ),
            structuredContent: Type.Optional(Type.Unsafe(structuredSchema)),
            isError: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: true },
    );
}

export async function toolResult(result: CallToolResult): Promise<AgentToolResult<CallToolResult>> {
    let content = toLlmContent(result);
    const text = content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n\n");
    if (truncateHead(text).truncated) {
        const directory = join(getAgentDir(), "tool-output", "pi-lazy-mcp");
        await mkdir(directory, { recursive: true });

        const path = join(directory, `${randomUUID()}.txt`);
        await writeFile(path, text, { mode: 0o600, flag: "wx" });

        let remainingLines = DEFAULT_MAX_LINES;
        let remainingBytes = DEFAULT_MAX_BYTES;

        content = content.filter((block) => {
            if (block.type !== "text") return true;
            if (remainingLines <= 0 || remainingBytes <= 0) return false;

            const preview = truncateHead(block.text, {
                maxLines: remainingLines,
                maxBytes: remainingBytes,
            });
            remainingLines -= preview.outputLines + 2;
            remainingBytes -= preview.outputBytes + 2;
            block.text = preview.content;
            return block.text !== "";
        });
        content.push({ type: "text", text: `MCP text truncated. Full text: ${path}` });
    }

    const { _meta, ...scriptResult } = result;
    return {
        content,
        details: result,
        isError: result.isError === true,
        structuredContent: Value.Parse(jsonValueSchema, scriptResult),
    };
}
