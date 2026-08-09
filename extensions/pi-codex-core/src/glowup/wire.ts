export type GlowupWireRecord = Readonly<Record<string, unknown>>;

export type GlowupWireToolResult = {
    readonly content?: unknown;
    readonly details?: unknown;
};

export type GlowupWireCallContext = {
    readonly toolName: string;
    readonly toolCallId: string;
    readonly phase: "pending" | "running" | "complete";
    readonly argsComplete: boolean;
    readonly isPartial: boolean;
    readonly expanded: boolean;
    readonly showImages: boolean;
    readonly isError: boolean;
};

export type GlowupWireResultContext<Args = unknown> = GlowupWireCallContext & {
    readonly args: Args;
};

export function isGlowupWireRecord(value: unknown): value is GlowupWireRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function glowupWireString(record: GlowupWireRecord, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}

export function glowupWireNumber(record: GlowupWireRecord, key: string): number | undefined {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function glowupWireArray(
    record: GlowupWireRecord,
    key: string,
): ReadonlyArray<unknown> | undefined {
    const value = record[key];
    return Array.isArray(value) ? value : undefined;
}

export function parseGlowupWireArgs(value: unknown): GlowupWireRecord | undefined {
    return isGlowupWireRecord(value) ? value : undefined;
}

export function parseGlowupWireResult(value: unknown): GlowupWireToolResult | undefined {
    if (!isGlowupWireRecord(value)) return undefined;
    return {
        ...(value.content === undefined ? {} : { content: value.content }),
        ...(value.details === undefined ? {} : { details: value.details }),
    };
}

export function glowupWireTextOutput(result: GlowupWireToolResult): string | undefined {
    if (!Array.isArray(result.content)) return undefined;
    const texts: string[] = [];
    for (const item of result.content) {
        if (!isGlowupWireRecord(item) || item.type !== "text" || typeof item.text !== "string") {
            continue;
        }
        texts.push(item.text);
    }
    return texts.length === 0 ? undefined : texts.join("\n");
}
