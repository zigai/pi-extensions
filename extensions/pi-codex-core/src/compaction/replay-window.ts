import { createHash } from "node:crypto";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { CodexRuntime } from "../runtime.ts";
import { compileSchema, parseWithSchema } from "../schema-parsing.ts";
import { NATIVE_COMPACTION_STRATEGY } from "./messages.ts";
import {
    isInstructionItem,
    isRemoteCompactionOutputItem,
    itemContainsShimSummary,
    parseResponsesInputItems,
    serializeEntriesToResponsesInput,
} from "./responses-input.ts";
import type {
    FoundNativeCompactionEntry,
    NativeCompactionDetails,
    NativeCompactionMatch,
    NativeReplayResult,
    ResponsesInputItem,
    ResponsesPayload,
} from "./types.ts";

const JsonObjectSchema = Type.Record(Type.String(), Type.Unknown());
const StringArraySchema = Type.Array(Type.String());
const NativeCompactionRequestMetaSchema = Type.Object({
    previousCompactionEntryId: Type.Optional(Type.String()),
    retainedInputItems: Type.Number(),
    rewrittenToolOutputs: Type.Number(),
    estimatedTokensBefore: Type.Number(),
    estimatedTokensAfter: Type.Number(),
    budgetTokens: Type.Optional(Type.Number()),
});
const NativeCompactionWorldStateSchema = Type.Object({
    cwd: Type.String(),
    model: Type.String(),
    activeToolNames: StringArraySchema,
    readFiles: StringArraySchema,
    modifiedFiles: StringArraySchema,
    capturedAt: Type.String(),
});
const NativeCompactionDetailsSchema = Type.Object({
    strategy: Type.Literal(NATIVE_COMPACTION_STRATEGY),
    provider: Type.String(),
    api: Type.String(),
    model: Type.String(),
    baseUrl: Type.String(),
    compactedWindow: Type.Array(JsonObjectSchema),
    replacementInput: Type.Optional(Type.Array(JsonObjectSchema)),
    windowNumber: Type.Number(),
    windowId: Type.String(),
    firstWindowId: Type.String(),
    previousWindowId: Type.Optional(Type.String()),
    sourceCompactionEntryId: Type.Optional(Type.String()),
    worldState: NativeCompactionWorldStateSchema,
    compactResponseId: Type.Optional(Type.String()),
    createdAt: Type.String(),
    requestMeta: Type.Optional(NativeCompactionRequestMetaSchema),
});
const NativeCompactionRequestMetaValidator = compileSchema(NativeCompactionRequestMetaSchema);
const NativeCompactionWorldStateValidator = compileSchema(NativeCompactionWorldStateSchema);
const NativeCompactionDetailsValidator = compileSchema(NativeCompactionDetailsSchema);

const nativeReplayWarningKeys = new Set<string>();

export function isNativeCompactionDetails(value: unknown): value is NativeCompactionDetails {
    return parseNativeCompactionDetails(value) !== undefined;
}

function parseNativeCompactionDetails(value: unknown): NativeCompactionDetails | undefined {
    const details = parseWithSchema(NativeCompactionDetailsValidator, value);
    if (!details) return undefined;
    const compactedWindow = parseResponsesInputItems(details.compactedWindow);
    const legacyReplacementInput =
        details.replacementInput === undefined
            ? undefined
            : parseResponsesInputItems(details.replacementInput);
    const worldState = parseWithSchema(NativeCompactionWorldStateValidator, details.worldState);
    const requestMeta =
        details.requestMeta === undefined
            ? undefined
            : parseWithSchema(NativeCompactionRequestMetaValidator, details.requestMeta);
    if (
        !compactedWindow ||
        !isValidCompactedWindow(compactedWindow) ||
        (details.replacementInput !== undefined && !legacyReplacementInput) ||
        !worldState ||
        !Number.isFinite(details.windowNumber) ||
        details.windowNumber < 1 ||
        (details.requestMeta !== undefined && !requestMeta)
    ) {
        return undefined;
    }
    return {
        strategy: NATIVE_COMPACTION_STRATEGY,
        provider: details.provider,
        api: details.api,
        model: details.model,
        baseUrl: details.baseUrl,
        compactedWindow,
        windowNumber: details.windowNumber,
        windowId: details.windowId,
        firstWindowId: details.firstWindowId,
        previousWindowId: details.previousWindowId,
        sourceCompactionEntryId: details.sourceCompactionEntryId,
        worldState,
        compactResponseId: details.compactResponseId,
        createdAt: details.createdAt,
        requestMeta,
    };
}

function isValidCompactedWindow(compactedWindow: readonly ResponsesInputItem[]): boolean {
    return (
        compactedWindow.filter(isRemoteCompactionOutputItem).length === 1 &&
        isRemoteCompactionOutputItem(compactedWindow.at(-1))
    );
}

export function findLatestNativeCompactionDetails(
    ctx: ExtensionContext,
): NativeCompactionDetails | undefined {
    const branch = ctx.sessionManager.getBranch();
    const latest = findLatestNativeCompactionEntry(branch);
    return latest?.entry.details;
}

export function findLatestNativeCompactionEntry(
    branch: readonly SessionEntry[],
    match?: NativeCompactionMatch,
): FoundNativeCompactionEntry | undefined {
    for (let index = branch.length - 1; index >= 0; index -= 1) {
        const entry = branch[index];
        if (!entry || entry.type !== "compaction") continue;
        const details = parseNativeCompactionDetails(entry.details);
        if (!details) continue;
        if (match && !nativeCompactionMatches(details, match)) continue;
        return { entry: { ...entry, details }, index };
    }
    return undefined;
}

export function findLatestActiveNativeCompactionEntry(
    branch: readonly SessionEntry[],
    match?: NativeCompactionMatch,
): FoundNativeCompactionEntry | undefined {
    const latestNative = findLatestNativeCompactionEntry(branch, match);
    if (!latestNative) return undefined;
    const superseded = branch
        .slice(latestNative.index + 1)
        .some((entry) => entry.type === "compaction");
    return superseded ? undefined : latestNative;
}

export function nativeCompactionMatches(
    details: Pick<NativeCompactionDetails, "provider" | "api" | "baseUrl">,
    match: NativeCompactionMatch,
): boolean {
    return (
        details.provider === match.provider &&
        details.api === match.api &&
        details.baseUrl === match.baseUrl
    );
}

export function buildWindowLifecycle(
    latestNativeCompaction: FoundNativeCompactionEntry | undefined,
    runtime: CodexRuntime,
): {
    readonly windowNumber: number;
    readonly windowId: string;
    readonly firstWindowId: string;
    readonly previousWindowId?: string | undefined;
    readonly sourceCompactionEntryId?: string | undefined;
} {
    const previousDetails = latestNativeCompaction?.entry.details;
    const windowId = runtime.idGenerator.randomUUID();
    const previousWindowId = previousDetails?.windowId;
    return {
        windowNumber: (previousDetails?.windowNumber ?? 0) + 1,
        windowId,
        firstWindowId: previousDetails?.firstWindowId ?? windowId,
        previousWindowId,
        sourceCompactionEntryId: latestNativeCompaction?.entry.id,
    };
}

export function rewriteResponsesPayloadWithNativeReplay(input: {
    readonly payload: ResponsesPayload;
    readonly model: ExtensionContext["model"];
    readonly branchEntries: readonly SessionEntry[];
    readonly compactionEntry: FoundNativeCompactionEntry["entry"];
    readonly replacementInput: readonly ResponsesInputItem[];
}): NativeReplayResult {
    const boundaryIndex = input.branchEntries.findIndex(
        (entry) => entry.id === input.compactionEntry.id,
    );
    if (boundaryIndex < 0) return { ok: false, reason: "compaction-boundary-not-found" };

    const firstKeptEntryIndex = input.branchEntries.findIndex(
        (entry, index) =>
            index < boundaryIndex && entry.id === input.compactionEntry.firstKeptEntryId,
    );
    if (firstKeptEntryIndex < 0) return { ok: false, reason: "first-kept-entry-not-found" };

    const inputItems = input.payload.input;
    const preambleCount = countLeadingInstructionItems(inputItems);
    const shimIndex = inputItems.findIndex(
        (item, index) => index >= preambleCount && itemContainsShimSummary(item),
    );
    if (shimIndex < 0) return { ok: false, reason: "compaction-shim-not-found" };

    const preCompactionKeptInput = serializeEntriesToResponsesInput(
        input.model,
        input.branchEntries.slice(firstKeptEntryIndex, boundaryIndex),
    );
    const afterShimIndex = shimIndex + 1;
    let keptReplayIndex = afterShimIndex;
    let afterKeptReplayIndex = afterShimIndex;
    if (preCompactionKeptInput.length > 0) {
        const matchedReplayIndex = findInputSliceIndex(
            inputItems,
            preCompactionKeptInput,
            afterShimIndex,
        );
        if (matchedReplayIndex < 0) {
            return { ok: false, reason: "expected-pi-replay-mismatch" };
        }
        keptReplayIndex = matchedReplayIndex;
        afterKeptReplayIndex = matchedReplayIndex + preCompactionKeptInput.length;
    }

    return {
        ok: true,
        payload: {
            ...input.payload,
            input: [
                ...inputItems.slice(0, shimIndex),
                ...input.replacementInput,
                ...inputItems.slice(afterShimIndex, keptReplayIndex),
                ...inputItems.slice(afterKeptReplayIndex),
            ],
        },
    };
}

export function buildLenientNativeReplayPayload(
    payload: ResponsesPayload,
    replacementInput: readonly ResponsesInputItem[],
): ResponsesPayload {
    const withoutShim = payload.input.filter((item) => !itemContainsShimSummary(item));
    let insertAt = 0;
    while (insertAt < withoutShim.length && isInstructionItem(withoutShim[insertAt])) insertAt += 1;
    return {
        ...payload,
        input: [
            ...withoutShim.slice(0, insertAt),
            ...replacementInput,
            ...withoutShim.slice(insertAt),
        ],
    };
}

export function notifyNativeReplayFallbackOnce(
    ctx: ExtensionContext,
    compactionEntryId: string,
    reason: string,
): void {
    if (reason === "expected-pi-replay-mismatch") return;
    if (!ctx.hasUI) return;
    const key = `${ctx.sessionManager.getSessionId()}:${compactionEntryId}:${reason}`;
    if (nativeReplayWarningKeys.has(key)) return;
    nativeReplayWarningKeys.add(key);
    ctx.ui.notify(
        `Codex native compaction replay fell back to lenient rewrite (${reason}).`,
        "warning",
    );
}

export function clearReplayWindowState(): void {
    nativeReplayWarningKeys.clear();
}

export function clearReplayWindowSessionState(sessionId: string): void {
    for (const key of nativeReplayWarningKeys) {
        if (key.startsWith(`${sessionId}:`)) nativeReplayWarningKeys.delete(key);
    }
}

function countLeadingInstructionItems(input: readonly ResponsesInputItem[]): number {
    let count = 0;
    while (count < input.length && isInstructionItem(input[count])) count += 1;
    return count;
}

function findInputSliceIndex(
    input: readonly ResponsesInputItem[],
    expected: readonly ResponsesInputItem[],
    fromIndex: number,
): number {
    if (expected.length === 0) return fromIndex;
    const expectedKeys = expected.map(stableFingerprint);
    const prefixTable = buildPrefixTable(expectedKeys);
    let matched = 0;
    for (let index = Math.max(0, fromIndex); index < input.length; index += 1) {
        const inputKey = stableFingerprint(input[index]);
        while (matched > 0 && inputKey !== expectedKeys[matched]) {
            matched = prefixTable[matched - 1] ?? 0;
        }
        if (inputKey !== expectedKeys[matched]) continue;
        matched += 1;
        if (matched === expectedKeys.length) return index - expectedKeys.length + 1;
    }
    return -1;
}

function buildPrefixTable(values: readonly string[]): number[] {
    const table = Array.from({ length: values.length }, () => 0);
    let prefixLength = 0;
    for (let index = 1; index < values.length; index += 1) {
        while (prefixLength > 0 && values[index] !== values[prefixLength]) {
            prefixLength = table[prefixLength - 1] ?? 0;
        }
        if (values[index] === values[prefixLength]) prefixLength += 1;
        table[index] = prefixLength;
    }
    return table;
}

function stableFingerprint(value: unknown): string {
    const hash = createHash("sha256");
    const stats = { chars: 0, nodes: 0 };
    updateStableFingerprint(hash, value, stats, new WeakSet<object>());
    return `${stats.chars}:${stats.nodes}:${hash.digest("base64url")}`;
}

function updateStableFingerprint(
    hash: ReturnType<typeof createHash>,
    value: unknown,
    stats: { chars: number; nodes: number },
    seen: WeakSet<object>,
): void {
    stats.nodes += 1;
    if (value === null) {
        hash.update("null;");
        return;
    }
    if (typeof value === "string") {
        stats.chars += value.length;
        hash.update(`string:${value.length}:`);
        hash.update(value);
        hash.update(";");
        return;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        hash.update(`${typeof value}:${String(value)};`);
        return;
    }
    if (typeof value === "undefined" || typeof value === "symbol" || typeof value === "function") {
        hash.update(`${typeof value};`);
        return;
    }
    if (seen.has(value)) {
        hash.update("circular;");
        return;
    }
    seen.add(value);
    if (Array.isArray(value)) {
        hash.update(`array:${value.length}[`);
        for (const item of value) updateStableFingerprint(hash, item, stats, seen);
        hash.update("];");
        seen.delete(value);
        return;
    }

    hash.update("object{");
    // SAFETY: Fingerprinting treats arbitrary object properties as unknown and never trusts them.
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
        left.localeCompare(right),
    );
    for (const [key, nested] of entries) {
        updateStableFingerprint(hash, key, stats, seen);
        updateStableFingerprint(hash, nested, stats, seen);
    }
    hash.update("};");
    seen.delete(value);
}
