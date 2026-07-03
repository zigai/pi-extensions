type UnknownRecord = {
    readonly [key: string]: unknown;
};

export type EditCallRenderContext = {
    readonly isError: boolean;
    readonly isPartial: boolean;
    readonly argsComplete?: boolean;
};

export type EditCallSummary = {
    readonly statusText: string;
    readonly path: string | undefined;
    readonly suffix: string;
    readonly hasInvalidEdits: boolean;
};

function isRecord(value: unknown): value is UnknownRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: UnknownRecord, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}

function hasEditTextPair(value: unknown): boolean {
    if (!isRecord(value)) {
        return false;
    }

    const hasNativePair = typeof value.oldText === "string" && typeof value.newText === "string";
    const hasCursorPair =
        typeof value.old_string === "string" && typeof value.new_string === "string";
    return hasNativePair || hasCursorPair;
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
    const path = record ? getString(record, "path") : undefined;
    const edits = record && Array.isArray(record.edits) ? record.edits : undefined;
    const validEdits = edits?.filter(hasEditTextPair).length ?? 0;
    const invalidEdits = edits === undefined ? 0 : edits.length - validEdits;

    if (invalidEdits > 0) {
        return {
            statusText: "Edit",
            path,
            suffix: formatInvalidEditCount(validEdits, invalidEdits),
            hasInvalidEdits: true,
        };
    }

    if (context.isError) {
        return {
            statusText: "Edit Failed",
            path,
            suffix: formatEditCount(validEdits),
            hasInvalidEdits: false,
        };
    }

    if (context.isPartial) {
        return {
            statusText: "Edit Pending",
            path,
            suffix: formatEditCount(validEdits),
            hasInvalidEdits: false,
        };
    }

    return {
        statusText: "Editing",
        path,
        suffix: formatEditCount(validEdits),
        hasInvalidEdits: false,
    };
}
