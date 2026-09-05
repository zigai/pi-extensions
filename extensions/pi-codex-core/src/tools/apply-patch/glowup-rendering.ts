import { diffPatchLines } from "./line-diff.ts";
import { Type } from "typebox";

import {
    call,
    empty,
    mutation,
    type GlowupMutationFile,
    type GlowupMutationLine,
    type GlowupRenderer,
} from "@zigai/pi-glowup/protocol";

import { parseApplyPatch, type ApplyPatchHunk } from "./engine.js";
import { compileSchema } from "../../schema-parsing.ts";

const PATCH_LABELS = {
    static: "Patch",
    running: "Patching",
    completed: "Patched",
    failed: "Failed to patch",
} as const;

type ApplyPatchRenderingArgs = {
    readonly patch: string;
    readonly files: readonly GlowupMutationFile[];
};

type ApplyPatchCallNode = ReturnType<typeof call> | ReturnType<typeof mutation>;

type ApplyPatchRenderingResult = {
    readonly patch: string;
    readonly files: readonly GlowupMutationFile[];
};

type PatchFileSummary = {
    readonly path: string;
    readonly previousPath?: string;
    readonly added: number;
    readonly removed: number;
    readonly countsKnown: boolean;
};

type GlowupMutationFileConstruction = {
    -readonly [Key in keyof GlowupMutationFile]: GlowupMutationFile[Key];
};

const PatchArgumentSchema = compileSchema(Type.Object({ patch: Type.String() }));
const PatchFileSummaryWireSchema = Type.Object({
    path: Type.String(),
    originalPath: Type.Optional(Type.String()),
    addedLines: Type.Integer({ minimum: 0 }),
    removedLines: Type.Optional(Type.Integer({ minimum: 0 })),
});
const ApplyPatchResultSchema = compileSchema(
    Type.Object({
        details: Type.Object({
            patch: Type.String(),
            lineSummary: Type.Object({ files: Type.Array(PatchFileSummaryWireSchema) }),
        }),
    }),
);

type ApplyPatchResultWire = ReturnType<(typeof ApplyPatchResultSchema)["Parse"]>;
type PatchFileSummaryWire = ApplyPatchResultWire["details"]["lineSummary"]["files"][number];

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

function splitContentLines(value: string): readonly string[] {
    if (value.length === 0) return [];
    const normalized = value.replace(/\r\n?/gu, "\n");
    const withoutTrailingLineBreak = normalized.endsWith("\n")
        ? normalized.slice(0, -1)
        : normalized;
    return withoutTrailingLineBreak.length === 0 ? [] : withoutTrailingLineBreak.split("\n");
}

function updateLines(
    hunk: Extract<ApplyPatchHunk, { readonly type: "update" }>,
): GlowupMutationLine[] {
    const lines: GlowupMutationLine[] = [];
    for (const chunk of hunk.chunks) {
        if (chunk.changeContext !== undefined && chunk.changeContext.length > 0) {
            lines.push({ kind: "metadata", text: `@@ ${chunk.changeContext}` });
        }
        lines.push(...diffPatchLines(chunk.oldLines, chunk.newLines));
    }
    return lines;
}

function mutationFileFromHunk(hunk: ApplyPatchHunk): GlowupMutationFile {
    if (hunk.type === "add") {
        const lines = splitContentLines(hunk.contents).map(
            (line): GlowupMutationLine => ({ kind: "addition", text: line }),
        );
        return {
            path: hunk.path,
            lines,
            added: lines.length,
            removed: 0,
        };
    }
    if (hunk.type === "delete") {
        return {
            path: hunk.path,
            lines: [],
            added: 0,
            removed: 0,
            countsKnown: false,
        };
    }
    const lines = updateLines(hunk);
    const added = lines.filter((line) => line.kind === "addition").length;
    const removed = lines.filter((line) => line.kind === "deletion").length;
    return hunk.movePath === undefined
        ? { path: hunk.path, lines, added, removed }
        : { path: hunk.movePath, previousPath: hunk.path, lines, added, removed };
}

function patchText(value: unknown): string | undefined {
    return PatchArgumentSchema.decode(value)?.patch;
}

function parseApplyPatchArgs(value: unknown): ApplyPatchRenderingArgs | undefined {
    const patch = patchText(value);
    if (patch === undefined) return undefined;
    const parsed = parseApplyPatch(patch);
    if (parsed.isErr() || parsed.value.hunks.length === 0) return undefined;
    return { patch, files: parsed.value.hunks.map(mutationFileFromHunk) };
}

type MutablePartialFile = {
    path: string;
    previousPath?: string;
    lines: GlowupMutationLine[];
    added: number;
    removed: number;
    countsKnown: boolean;
    kind: "add" | "delete" | "update";
};

function partialFile(kind: MutablePartialFile["kind"], path: string): MutablePartialFile {
    return {
        kind,
        path,
        lines: [],
        added: 0,
        removed: 0,
        countsKnown: kind !== "delete",
    };
}

function parsePartialPatchFiles(patch: string): readonly GlowupMutationFile[] {
    const files: MutablePartialFile[] = [];
    let current: MutablePartialFile | undefined;
    for (const rawLine of removeUnpairedSurrogates(patch).replace(/\r\n?/gu, "\n").split("\n")) {
        const header = /^\*\*\* (?<kind>Add|Delete|Update) File: (?<path>.+)$/u.exec(rawLine);
        if (header?.groups !== undefined) {
            const kind = header.groups.kind?.toLowerCase();
            const path = header.groups.path?.trim();
            if (
                path !== undefined &&
                path.length > 0 &&
                (kind === "add" || kind === "delete" || kind === "update")
            ) {
                current = partialFile(kind, path);
                files.push(current);
            }
            continue;
        }
        if (current === undefined) continue;
        if (current.kind === "update" && rawLine.startsWith("*** Move to: ")) {
            const movePath = rawLine.slice("*** Move to: ".length).trim();
            if (movePath.length > 0) {
                current.previousPath = current.path;
                current.path = movePath;
            }
            continue;
        }
        if (rawLine.startsWith("@@")) {
            current.lines.push({ kind: "metadata", text: rawLine });
            continue;
        }
        if (current.kind === "add" && rawLine.startsWith("+")) {
            current.lines.push({ kind: "addition", text: rawLine.slice(1) });
            current.added += 1;
            continue;
        }
        if (current.kind !== "update") continue;
        if (rawLine.startsWith("+")) {
            current.lines.push({ kind: "addition", text: rawLine.slice(1) });
            current.added += 1;
        } else if (rawLine.startsWith("-")) {
            current.lines.push({ kind: "deletion", text: rawLine.slice(1) });
            current.removed += 1;
        } else if (rawLine.startsWith(" ")) {
            current.lines.push({ kind: "context", text: rawLine.slice(1) });
        }
    }
    return files.map((file) => {
        const mutationFile: GlowupMutationFileConstruction =
            file.previousPath === undefined
                ? {
                      path: file.path,
                      lines: file.lines,
                      added: file.added,
                      removed: file.removed,
                  }
                : {
                      path: file.path,
                      previousPath: file.previousPath,
                      lines: file.lines,
                      added: file.added,
                      removed: file.removed,
                  };
        if (!file.countsKnown) mutationFile.countsKnown = false;
        return mutationFile;
    });
}

function parsePartialCall(value: unknown): ApplyPatchCallNode {
    const patch = patchText(value);
    if (patch === undefined) return call(PATCH_LABELS);
    const files = parsePartialPatchFiles(patch);
    return files.length === 0 ? call(PATCH_LABELS) : mutation(PATCH_LABELS, files);
}

function parseFileSummary(value: PatchFileSummaryWire): PatchFileSummary {
    const removed = value.removedLines;
    return value.originalPath === undefined
        ? {
              path: value.path,
              added: value.addedLines,
              removed: removed ?? 0,
              countsKnown: removed !== undefined,
          }
        : {
              path: value.path,
              previousPath: value.originalPath,
              added: value.addedLines,
              removed: removed ?? 0,
              countsKnown: removed !== undefined,
          };
}

function parseUnifiedPatchLines(patch: string): readonly (readonly GlowupMutationLine[])[] {
    const sections: GlowupMutationLine[][] = [];
    let lines: GlowupMutationLine[] | undefined;
    let oldLine: number | undefined;
    let newLine: number | undefined;
    for (const line of patch.replace(/\r\n?/gu, "\n").split("\n")) {
        if (line.startsWith("--- ")) {
            lines = [];
            sections.push(lines);
            oldLine = undefined;
            newLine = undefined;
            continue;
        }
        if (lines === undefined || line.startsWith("+++ ")) continue;
        const hunk = /^@@ -(?<old>\d+)(?:,\d+)? \+(?<next>\d+)(?:,\d+)? @@/u.exec(line);
        if (hunk?.groups !== undefined) {
            oldLine = Number(hunk.groups.old);
            newLine = Number(hunk.groups.next);
            continue;
        }
        if (line.startsWith("+") && newLine !== undefined) {
            lines.push({ kind: "addition", text: line.slice(1), newLine });
            newLine += 1;
        } else if (line.startsWith("-") && oldLine !== undefined) {
            lines.push({ kind: "deletion", text: line.slice(1), oldLine });
            oldLine += 1;
        } else if (line.startsWith(" ") && oldLine !== undefined && newLine !== undefined) {
            lines.push({ kind: "context", text: line.slice(1), oldLine, newLine });
            oldLine += 1;
            newLine += 1;
        } else if (line.startsWith("\\ No newline")) {
            lines.push({ kind: "metadata", text: line });
        }
    }
    return sections;
}

function parseApplyPatchResult(value: unknown): ApplyPatchRenderingResult | undefined {
    const result = ApplyPatchResultSchema.decode(value);
    if (result === undefined || result.details.lineSummary.files.length === 0) return undefined;
    const patch = result.details.patch;
    const patchLines = parseUnifiedPatchLines(patch);
    return {
        patch,
        files: result.details.lineSummary.files.map((rawFile, index) => {
            const file = parseFileSummary(rawFile);
            const mutationFile: GlowupMutationFileConstruction =
                file.previousPath === undefined
                    ? {
                          path: file.path,
                          lines: patchLines[index] ?? [],
                          added: file.added,
                          removed: file.removed,
                      }
                    : {
                          path: file.path,
                          previousPath: file.previousPath,
                          lines: patchLines[index] ?? [],
                          added: file.added,
                          removed: file.removed,
                      };
            if (!file.countsKnown) mutationFile.countsKnown = false;
            return mutationFile;
        }),
    };
}

export const applyPatchGlowupRendering = {
    version: 3,
    parseArgs: parseApplyPatchArgs,
    parseResult: parseApplyPatchResult,
    renderPartialCall: parsePartialCall,
    renderCall(args, context) {
        return context.hasResult === true ? empty() : mutation(PATCH_LABELS, args.files);
    },
    renderResult(result) {
        return mutation(PATCH_LABELS, result.files, { patch: result.patch });
    },
} satisfies GlowupRenderer<ApplyPatchRenderingArgs, ApplyPatchRenderingResult>;
