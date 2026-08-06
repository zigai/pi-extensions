import { isActiveToolCall, toolStatusLabel, type ToolLabelMode } from "./status-labels.ts";
import { isRecord, stringField } from "../unknown-values.ts";

type EditTextPair = {
    readonly oldText: string;
    readonly newText: string;
};

export type EditCallRenderContext = {
    readonly isError: boolean;
    readonly isPartial: boolean;
    readonly argsComplete?: boolean;
    readonly labelMode?: ToolLabelMode;
};

export type EditCallSummary = {
    readonly statusText: string;
    readonly path: string | undefined;
    readonly suffix: string;
    readonly hasInvalidEdits: boolean;
};

function editTextPair(value: unknown): EditTextPair | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    if (typeof value.oldText === "string" && typeof value.newText === "string") {
        return { oldText: value.oldText, newText: value.newText };
    }
    if (typeof value.old_string === "string" && typeof value.new_string === "string") {
        return { oldText: value.old_string, newText: value.new_string };
    }
    return undefined;
}

function hasEditTextPair(value: unknown): boolean {
    return editTextPair(value) !== undefined;
}

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

export function summarizeEditCall(args: unknown, context: EditCallRenderContext): EditCallSummary {
    const record = isRecord(args) ? args : undefined;
    const path = record === undefined ? undefined : stringField(record, "path");
    const edits = record && Array.isArray(record.edits) ? record.edits : undefined;
    const validEdits = edits?.filter(hasEditTextPair).length ?? 0;
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

    if (context.isError) {
        return {
            statusText: editLabel,
            path,
            suffix: formatEditCount(validEdits),
            hasInvalidEdits: false,
        };
    }

    return {
        statusText: editLabel,
        path,
        suffix: formatEditCount(validEdits),
        hasInvalidEdits: false,
    };
}
