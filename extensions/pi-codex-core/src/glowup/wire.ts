import { Type } from "typebox";

import { compileSchema, StringDecoder } from "../schema-parsing.ts";

export type GlowupWireValue =
    | string
    | number
    | boolean
    | null
    | readonly GlowupWireValue[]
    | GlowupWireRecord;

export interface GlowupWireRecord {
    readonly [key: string]: GlowupWireValue | undefined;
}

export type GlowupWireToolResult = {
    readonly content?: GlowupWireValue | undefined;
    readonly details?: GlowupWireValue | undefined;
};

const GlowupWireValueSchema = Type.Cyclic(
    {
        GlowupWireValue: Type.Union([
            Type.String(),
            Type.Number(),
            Type.Boolean(),
            Type.Null(),
            Type.Array(Type.Ref("GlowupWireValue")),
            Type.Record(Type.String(), Type.Union([Type.Ref("GlowupWireValue"), Type.Undefined()])),
        ]),
    },
    "GlowupWireValue",
);
const GlowupWireRecordSchema = Type.Record(
    Type.String(),
    Type.Union([GlowupWireValueSchema, Type.Undefined()]),
);
export const GlowupWireRecordDecoder = compileSchema(GlowupWireRecordSchema);
const GlowupWireToolResultDecoder = compileSchema(
    Type.Object({
        content: Type.Optional(GlowupWireValueSchema),
        details: Type.Optional(GlowupWireValueSchema),
    }),
);
const GlowupWireNumberDecoder = compileSchema(Type.Number());
const GlowupWireArrayDecoder = compileSchema(Type.Array(GlowupWireValueSchema));

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

export function parseGlowupWireRecord(value: unknown): GlowupWireRecord | undefined {
    return GlowupWireRecordDecoder.decode(value);
}

export function glowupWireString(record: GlowupWireRecord, key: string): string | undefined {
    return StringDecoder.decode(record[key]);
}

export function glowupWireNumber(record: GlowupWireRecord, key: string): number | undefined {
    return GlowupWireNumberDecoder.decode(record[key]);
}

export function glowupWireArray(
    record: GlowupWireRecord,
    key: string,
): ReadonlyArray<unknown> | undefined {
    return GlowupWireArrayDecoder.decode(record[key]);
}

export function parseGlowupWireArgs(value: unknown): GlowupWireRecord | undefined {
    return GlowupWireRecordDecoder.decode(value);
}

export function parseGlowupWireResult(value: unknown): GlowupWireToolResult | undefined {
    const result = GlowupWireToolResultDecoder.decode(value);
    if (!result) return undefined;
    if (result.content === undefined) {
        return result.details === undefined ? {} : { details: result.details };
    }
    return result.details === undefined
        ? { content: result.content }
        : { content: result.content, details: result.details };
}

export function glowupWireTextOutput(result: GlowupWireToolResult): string | undefined {
    if (!Array.isArray(result.content)) return undefined;
    const texts: string[] = [];
    for (const item of result.content) {
        const record = GlowupWireRecordDecoder.decode(item);
        const text = StringDecoder.decode(record?.text);
        if (record?.type !== "text" || text === undefined) continue;
        texts.push(text);
    }
    return texts.length === 0 ? undefined : texts.join("\n");
}
