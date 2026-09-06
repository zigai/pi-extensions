import { defineTool } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "../../src/json-value.ts";
import {
    empty,
    mutation,
    withGlowupRendering,
    type GlowupMutationFile,
} from "../../src/tools/protocol/contract.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";

const labels = {
    static: "Patch",
    running: "Patching",
    completed: "Patched",
    failed: "Failed to patch",
} as const;

const patchArgsSchema = Type.Object({ patch: Type.String() });
const patchResultSchema = Type.Object({
    details: Type.Object({
        patch: Type.String(),
        inputPatch: Type.Optional(Type.String()),
        lineSummary: Type.Optional(
            Type.Object({
                files: Type.Array(
                    Type.Object({
                        path: Type.String(),
                        addedLines: Type.Optional(Type.Number()),
                        removedLines: Type.Optional(Type.Number()),
                    }),
                ),
            }),
        ),
    }),
});

function removeUnpairedSurrogates(value: string): string {
    let normalized = "";
    for (let index = 0; index < value.length; index += 1) {
        const codeUnit = value.charCodeAt(index);
        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                normalized += value.slice(index, index + 2);
                index += 1;
            }
            continue;
        }
        if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) continue;
        normalized += value[index] ?? "";
    }
    return normalized;
}

function filesFromPatch(patch: string): GlowupMutationFile[] {
    const files: Array<{
        path: string;
        lines: Array<{ kind: "context" | "addition" | "deletion"; text: string }>;
        added: number;
        removed: number;
    }> = [];
    let current: (typeof files)[number] | undefined;
    for (const line of removeUnpairedSurrogates(patch).split(/\r?\n/gu)) {
        const header = /^\*\*\* (?:Add|Delete|Update) File: (?<path>.+)$/u.exec(line);
        if (header?.groups?.path !== undefined) {
            current = { path: header.groups.path, lines: [], added: 0, removed: 0 };
            files.push(current);
            continue;
        }
        if (current === undefined) continue;
        if (line.startsWith("+")) {
            current.lines.push({ kind: "addition", text: line.slice(1) });
            current.added += 1;
        } else if (line.startsWith("-")) {
            current.lines.push({ kind: "deletion", text: line.slice(1) });
            current.removed += 1;
        } else if (line.startsWith(" ")) {
            current.lines.push({ kind: "context", text: line.slice(1) });
        }
    }
    return files;
}

function parseArgs(value: JsonValue) {
    const parsed = Value.Parse(patchArgsSchema, value);
    const files = filesFromPatch(parsed.patch);
    return files.length === 0 ? undefined : { patch: parsed.patch, files };
}

function parseResult(value: JsonValue) {
    const parsed = Value.Parse(patchResultSchema, value);
    const files = filesFromPatch(parsed.details.inputPatch ?? parsed.details.patch);
    if (files.length === 0 && parsed.details.lineSummary !== undefined) {
        for (const file of parsed.details.lineSummary.files) {
            files.push({
                path: file.path,
                lines: [],
                added: file.addedLines ?? 0,
                removed: file.removedLines ?? 0,
            });
        }
    }
    return files.length === 0 ? undefined : { patch: parsed.details.patch, files };
}

export const applyPatchOwnerRendering = {
    version: 3,
    parseArgs,
    parseResult,
    renderPartialCall(value: JsonValue) {
        let parsed;
        try {
            parsed = Value.Parse(patchArgsSchema, value);
        } catch {
            return mutation(labels, [{ path: "…", lines: [], added: 0, removed: 0 }]);
        }
        const files = filesFromPatch(parsed.patch);
        return files.length === 0
            ? mutation(labels, [{ path: "…", lines: [], added: 0, removed: 0 }])
            : mutation(labels, files);
    },
    renderCall(
        args: NonNullable<ReturnType<typeof parseArgs>>,
        context: { readonly hasResult?: boolean },
    ) {
        return context.hasResult === true ? empty() : mutation(labels, args.files);
    },
    renderResult(result: NonNullable<ReturnType<typeof parseResult>>) {
        return mutation(labels, result.files, { patch: result.patch });
    },
} as const;

export const applyPatchOwnerToolDefinition = withGlowupRendering(
    defineTool({
        name: "apply_patch",
        label: "Apply Patch",
        description: "Deterministic owner-rendering fixture for Glowup integration tests.",
        parameters: Type.Object({ patch: Type.String() }),
        async execute() {
            return { content: [{ type: "text" as const, text: "Done!" }], details: undefined };
        },
    }),
    applyPatchOwnerRendering,
);
