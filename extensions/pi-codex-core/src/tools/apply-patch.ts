import { resolve } from "node:path";

import { Text } from "@earendil-works/pi-tui";
import {
    withFileMutationQueue,
    type ExtensionAPI,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import {
    ApplyPatchError,
    applyPatchText,
    formatApplyPatchError,
    parseApplyPatch,
    type ApplyPatchAffectedPaths,
} from "../apply-patch.ts";
import { compileSchema, parseWithSchema } from "../schema-parsing.ts";

export const APPLY_PATCH_TOOL_NAME = "apply_patch";

const APPLY_PATCH_PARAMETERS = Type.Object(
    {
        patch: Type.String({
            description:
                "Full Codex apply_patch document, from *** Begin Patch through *** End Patch.",
        }),
    },
    { additionalProperties: false },
);

const ApplyPatchParametersValidator = compileSchema(APPLY_PATCH_PARAMETERS);

type ApplyPatchParams = Static<typeof APPLY_PATCH_PARAMETERS>;

export type ApplyPatchToolDetails = {
    readonly affectedPaths: ApplyPatchAffectedPaths;
    readonly changedFileCount: number;
};

type ApplyPatchToolOptions = {
    readonly cwd?: string | undefined;
};

export function registerApplyPatchTool(
    pi: ExtensionAPI,
    options: ApplyPatchToolOptions = {},
): void {
    pi.registerTool(createApplyPatchTool(options));
}

export function createApplyPatchTool(
    options: ApplyPatchToolOptions = {},
): ToolDefinition<typeof APPLY_PATCH_PARAMETERS, ApplyPatchToolDetails> {
    return {
        name: APPLY_PATCH_TOOL_NAME,
        label: "Apply Patch",
        description:
            "Use the `apply_patch` tool to edit files. Provide a complete patch body in the patch argument.",
        promptSnippet: "Edit files with apply_patch patches.",
        promptGuidelines: [
            "Use apply_patch to edit files.",
            "The patch must start with *** Begin Patch and end with *** End Patch.",
            "Use *** Add File, *** Delete File, and *** Update File sections. Paths are relative, and added lines start with +.",
        ],
        parameters: APPLY_PATCH_PARAMETERS,
        prepareArguments: prepareApplyPatchArguments,
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const cwd = resolve(options.cwd ?? ctx.cwd);
            return withFileMutationQueue(cwd, async () => {
                try {
                    const result = await applyPatchText(params.patch, cwd, { signal });
                    return {
                        content: [{ type: "text", text: result.summary }],
                        details: {
                            affectedPaths: result.affectedPaths,
                            changedFileCount: result.changes.length,
                        },
                    };
                } catch (cause: unknown) {
                    if (cause instanceof ApplyPatchError) {
                        throw new Error(formatApplyPatchError(cause));
                    }
                    if (cause instanceof Error) throw cause;
                    throw new Error(String(cause));
                }
            });
        },
        renderCall(args, theme, _context) {
            const summary = summarizeApplyPatchCall(args.patch);
            const text =
                theme.fg("toolTitle", theme.bold("apply_patch ")) +
                theme.fg(
                    summary.length > 0 ? "accent" : "dim",
                    summary.length > 0 ? summary : "...",
                );
            return new Text(text, 0, 0);
        },
        renderResult(result, { expanded, isPartial }, theme, _context) {
            if (isPartial) return new Text(theme.fg("warning", "Applying patch..."), 0, 0);
            const output = result.content
                .filter((item) => item.type === "text")
                .map((item) => item.text)
                .join("\n");
            if (expanded) return new Text(theme.fg("toolOutput", output), 0, 0);
            return new Text(
                theme.fg(
                    "toolOutput",
                    compactApplyPatchSummary(output, result.details.affectedPaths),
                ),
                0,
                0,
            );
        },
    };
}

function prepareApplyPatchArguments(args: unknown): ApplyPatchParams {
    if (typeof args === "string") return { patch: args };
    if (typeof args === "object" && args !== null) {
        const patch =
            readStringProperty(args, "patch") ??
            readStringProperty(args, "input") ??
            readStringProperty(args, "command");
        if (patch !== undefined) return { patch };
    }
    const params = parseWithSchema(ApplyPatchParametersValidator, args);
    if (!params) throw new Error("Invalid apply_patch arguments.");
    return params;
}

function readStringProperty(value: object, key: string): string | undefined {
    const property = Object.getOwnPropertyDescriptor(value, key)?.value;
    return typeof property === "string" ? property : undefined;
}

function summarizeApplyPatchCall(patch: string): string {
    try {
        const parsed = parseApplyPatch(patch);
        const parts = parsed.hunks.slice(0, 3).map((hunk) => {
            if (hunk.type === "add") return `A ${hunk.path}`;
            if (hunk.type === "delete") return `D ${hunk.path}`;
            return `M ${hunk.movePath ?? hunk.path}`;
        });
        const remaining = parsed.hunks.length - parts.length;
        return remaining > 0 ? `${parts.join(", ")} +${remaining} more` : parts.join(", ");
    } catch {
        return "patch";
    }
}

function compactApplyPatchSummary(output: string, affectedPaths: ApplyPatchAffectedPaths): string {
    const paths = [
        ...affectedPaths.added.map((path) => `A ${path}`),
        ...affectedPaths.modified.map((path) => `M ${path}`),
        ...affectedPaths.deleted.map((path) => `D ${path}`),
    ];
    if (paths.length === 0) return output.trimEnd();
    const visible = paths.slice(0, 4);
    const remaining = paths.length - visible.length;
    return remaining > 0 ? `${visible.join("\n")}\n… ${remaining} more` : visible.join("\n");
}
