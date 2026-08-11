import { defineTool } from "@earendil-works/pi-coding-agent";
import {
    empty,
    mutation,
    withGlowupRendering,
    type GlowupMutationFile,
} from "../../src/tool-rendering/protocol.ts";
import { Type } from "typebox";

const labels = {
    static: "Patch",
    running: "Patching",
    completed: "Patched",
    failed: "Failed to patch",
} as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function parseArgs(value: unknown) {
    if (!isRecord(value) || typeof value.patch !== "string") return undefined;
    const files = filesFromPatch(value.patch);
    return files.length === 0 ? undefined : { patch: value.patch, files };
}

function parseResult(value: unknown) {
    if (!isRecord(value) || !isRecord(value.details) || typeof value.details.patch !== "string") {
        return undefined;
    }
    const files = filesFromPatch(
        typeof value.details.inputPatch === "string"
            ? value.details.inputPatch
            : value.details.patch,
    );
    if (
        files.length === 0 &&
        isRecord(value.details.lineSummary) &&
        Array.isArray(value.details.lineSummary.files)
    ) {
        for (const rawFile of value.details.lineSummary.files) {
            if (!isRecord(rawFile) || typeof rawFile.path !== "string") return undefined;
            const added = typeof rawFile.addedLines === "number" ? rawFile.addedLines : 0;
            const removed = typeof rawFile.removedLines === "number" ? rawFile.removedLines : 0;
            files.push({ path: rawFile.path, lines: [], added, removed });
        }
    }
    return files.length === 0 ? undefined : { patch: value.details.patch, files };
}

export const applyPatchOwnerRendering = {
    version: 3,
    parseArgs,
    parseResult,
    renderPartialCall(value: unknown) {
        if (!isRecord(value) || typeof value.patch !== "string")
            return mutation(labels, [{ path: "…", lines: [], added: 0, removed: 0 }]);
        const files = filesFromPatch(value.patch);
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
