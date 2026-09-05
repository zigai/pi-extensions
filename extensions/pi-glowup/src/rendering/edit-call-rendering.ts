import { isActiveToolCall, toolStatusLabel, type ToolLabelMode } from "./status-labels.ts";

export type EditTextPair = {
    readonly oldText: string;
    readonly newText: string;
};

export type EditCallArgs = {
    readonly path?: string;
    readonly edits?: ReadonlyArray<EditTextPair | null>;
};

export type EditCallRenderContext = {
    readonly isError: boolean;
    readonly isPartial: boolean;
    readonly argsComplete?: boolean;
    readonly labelMode?: ToolLabelMode;
    readonly result?: unknown;
};

export type EditCallSummary = {
    readonly statusText: string;
    readonly path: string | undefined;
    readonly suffix: string;
    readonly hasInvalidEdits: boolean;
};

function formatEditCount(validEdits: number): string {
    if (validEdits <= 1) {
        return "";
    }
    return ` (${validEdits} edits)`;
}

function formatInvalidEditCount(validEdits: number, invalidEdits: number): string {
    const validText = `${validEdits} valid`;
    const invalidText = `${invalidEdits} invalid`;
    return ` (${validText}, ${invalidText})`;
}

export function summarizeEditCall(
    args: EditCallArgs,
    context: EditCallRenderContext,
): EditCallSummary {
    const path = args.path;
    const edits = args.edits;
    const validEdits = edits?.filter((edit) => edit !== null).length ?? 0;
    const invalidEdits = edits === undefined ? 0 : edits.length - validEdits;

    const editLabel = toolStatusLabel(context.labelMode ?? "static", context, {
        static: "Edit",
        active: "Editing",
        completed: "Edited",
    });

    if (invalidEdits > 0 && !isActiveToolCall(context)) {
        return {
            statusText: editLabel,
            path,
            suffix: formatInvalidEditCount(validEdits, invalidEdits),
            hasInvalidEdits: true,
        };
    }

    return {
        statusText: editLabel,
        path,
        suffix: formatEditCount(validEdits),
        hasInvalidEdits: false,
    };
}
