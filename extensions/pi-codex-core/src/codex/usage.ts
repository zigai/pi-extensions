import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractAccountId, isModelWithStringApi, resolveCodexApiProviderBaseUrl } from "./auth.ts";
import {
    CodexAuthUnavailable,
    CodexHttpRequestFailed,
    CodexInvalidJson,
    CodexNetworkUnavailable,
    CodexRequestCancelled,
    CodexUnsupportedModel,
    fail,
    isAbortCause,
    ok,
    type CodexResult,
} from "./failures.ts";
import {
    defaultCodexRuntime,
    systemClock,
    type Clock,
    type CodexRuntime,
    type IdGenerator,
} from "../runtime.ts";
import {
    JsonArrayDecoder,
    JsonNumberDecoder,
    JsonObjectDecoder,
    JsonStringDecoder,
    JsonValueDecoder,
} from "../compaction/responses-input.ts";
import type { JsonValue } from "../compaction/types.ts";

const RESET_CREDITS_CACHE_MS = 5_000;
const RESET_CREDIT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

type RuntimeModel = Model<Api>;

const StringSchema = JsonStringDecoder;

export type CodexUsageWindow = {
    readonly usedPercent?: number | undefined;
    readonly windowMinutes?: number | undefined;
    readonly resetsAt?: number | undefined;
};

export type CodexUsageLimit = {
    readonly limitId: string;
    readonly limitName?: string | undefined;
    readonly primary?: CodexUsageWindow | undefined;
    readonly secondary?: CodexUsageWindow | undefined;
};

type CodexUsageLimitConstruction = {
    -readonly [Key in keyof CodexUsageLimit]: CodexUsageLimit[Key];
};

export type CodexRateLimitResetCredit = {
    readonly id?: string | undefined;
    readonly resetType?: string | undefined;
    readonly status?: string | undefined;
    readonly grantedAt?: string | undefined;
    readonly expiresAt?: string | undefined;
    readonly redeemStartedAt?: string | undefined;
    readonly redeemedAt?: string | undefined;
    readonly title?: string | undefined;
    readonly description?: string | undefined;
};

export type CodexRateLimitResetCredits = {
    readonly availableCount: number;
    readonly credits: readonly CodexRateLimitResetCredit[];
    readonly raw: JsonValue;
};

export type CodexUsageSnapshot = {
    readonly planType?: string | undefined;
    readonly limits: readonly CodexUsageLimit[];
    readonly resetCredits?: CodexRateLimitResetCredits | undefined;
    readonly raw: JsonValue | undefined;
};

export type CodexRateLimitResetConsumeOutcome =
    | "reset"
    | "already_redeemed"
    | "nothing_to_reset"
    | "no_credit"
    | "unknown";

export type CodexRateLimitResetConsumeResult = {
    readonly outcome: CodexRateLimitResetConsumeOutcome;
    readonly windowsReset?: number | undefined;
    readonly raw: JsonValue | undefined;
};

let resetCreditsCache:
    | {
          readonly key: string;
          readonly expiresAt: number;
          readonly credits: CodexRateLimitResetCredits;
      }
    | undefined;
let resetCreditsCacheGeneration = 0;

export function buildCodexUsageUrl(modelBaseUrl?: string): string {
    return `${resolveCodexWhamBaseUrl(modelBaseUrl)}/wham/usage`;
}

export function buildCodexRateLimitResetCreditsUrl(modelBaseUrl?: string): string {
    return `${resolveCodexWhamBaseUrl(modelBaseUrl)}/wham/rate-limit-reset-credits`;
}

export function buildCodexRateLimitResetConsumeUrl(modelBaseUrl?: string): string {
    return `${resolveCodexWhamBaseUrl(modelBaseUrl)}/wham/rate-limit-reset-credits/consume`;
}

function resolveCodexWhamBaseUrl(modelBaseUrl: string | undefined): string {
    const codexBaseUrl = resolveCodexApiProviderBaseUrl(modelBaseUrl);
    return codexBaseUrl.endsWith("/codex") ? codexBaseUrl.slice(0, -"/codex".length) : codexBaseUrl;
}

export type CodexUsageOptions = {
    readonly runtime?: CodexRuntime | undefined;
    readonly signal?: AbortSignal | undefined;
};

export async function fetchCodexUsage(
    ctx: ExtensionContext,
    options: CodexUsageOptions = {},
): Promise<CodexResult<CodexUsageSnapshot>> {
    const runtime = options.runtime ?? defaultCodexRuntime;
    const signal = options.signal ?? ctx.signal;
    const model = requireOpenAICodexModel(ctx.model);
    if (model.isErr()) return model;
    const headers = await buildCodexUsageHeaders(ctx, model.value);
    if (headers.isErr()) return headers;

    const requestInit: RequestInit = { method: "GET", headers: headers.value };
    if (signal) requestInit.signal = signal;
    const response = await fetchUsageResponse(
        runtime,
        buildCodexUsageUrl(model.value.baseUrl),
        requestInit,
    );
    if (response.isErr()) return response;
    if (!response.value.ok) {
        return fail(
            new CodexHttpRequestFailed({
                operation: "codexUsage",
                provider: "openai-codex",
                status: response.value.status,
                message: `Codex usage request failed with HTTP ${response.value.status}.`,
            }),
        );
    }

    const rawUsagePayload = await parseJsonResponse(response.value, "codexUsage");
    if (rawUsagePayload.isErr()) return rawUsagePayload;
    const snapshot = parseCodexUsagePayload(rawUsagePayload.value);
    if (snapshot.resetCredits && snapshot.resetCredits.availableCount <= 0) return ok(snapshot);

    const detailedResetCredits = await fetchCodexRateLimitResetCreditsWithHeaders(
        headers.value,
        model.value.baseUrl,
        runtime,
        { signal },
    );
    if (detailedResetCredits.isErr() || !detailedResetCredits.value) return ok(snapshot);
    return ok({ ...snapshot, resetCredits: detailedResetCredits.value });
}

export function createCodexRateLimitResetRedeemRequestId(
    idGenerator: IdGenerator = defaultCodexRuntime.idGenerator,
): string {
    return idGenerator.randomUUID();
}

export async function consumeCodexRateLimitResetCredit(
    ctx: ExtensionContext,
    redeemRequestId = createCodexRateLimitResetRedeemRequestId(),
    options: CodexUsageOptions = {},
): Promise<CodexResult<CodexRateLimitResetConsumeResult>> {
    const runtime = options.runtime ?? defaultCodexRuntime;
    const signal = options.signal ?? ctx.signal;
    const model = requireOpenAICodexModel(ctx.model);
    if (model.isErr()) return model;
    const headers = await buildCodexUsageHeaders(ctx, model.value);
    if (headers.isErr()) return headers;
    headers.value.set("content-type", "application/json");
    resetCreditsCacheGeneration += 1;
    resetCreditsCache = undefined;

    const requestInit: RequestInit = {
        method: "POST",
        headers: headers.value,
        body: JSON.stringify({ redeem_request_id: redeemRequestId }),
    };
    if (signal) requestInit.signal = signal;
    const response = await fetchUsageResponse(
        runtime,
        buildCodexRateLimitResetConsumeUrl(model.value.baseUrl),
        requestInit,
    ).finally(() => {
        resetCreditsCacheGeneration += 1;
        resetCreditsCache = undefined;
    });
    if (response.isErr()) return response;
    if (!response.value.ok) {
        return fail(
            new CodexHttpRequestFailed({
                operation: "codexResetCredit",
                provider: "openai-codex",
                status: response.value.status,
                message: `Codex reset request failed with HTTP ${response.value.status}.`,
            }),
        );
    }

    const rawConsumePayload = await parseJsonResponse(response.value, "codexResetCredit");
    if (rawConsumePayload.isErr()) return rawConsumePayload;
    return ok(parseCodexRateLimitResetConsumePayload(rawConsumePayload.value));
}

export function parseCodexUsagePayload(payload: unknown): CodexUsageSnapshot {
    const raw = JsonValueDecoder.decode(payload);
    const root = JsonObjectDecoder.decode(raw) ?? {};
    const limits: CodexUsageLimit[] = [];
    const addLimit = (
        limitId: string,
        limitName: string | undefined,
        source: JsonValue | undefined,
    ): void => {
        const sourceRecord = JsonObjectDecoder.decode(source);
        const rateLimit =
            sourceRecord && "rate_limit" in sourceRecord ? sourceRecord.rate_limit : source;
        const parsed = parseRateLimit(rateLimit);
        const limit: CodexUsageLimitConstruction = { limitId };
        if (limitName) limit.limitName = limitName;
        if (parsed.primary) limit.primary = parsed.primary;
        if (parsed.secondary) limit.secondary = parsed.secondary;
        limits.push(limit);
    };

    addLimit("codex", undefined, root.rate_limit);
    if (Array.isArray(root.additional_rate_limits)) {
        for (const item of root.additional_rate_limits) {
            const additionalLimit = JsonObjectDecoder.decode(item);
            if (!additionalLimit) continue;
            addLimit(
                parseString(additionalLimit.metered_feature) ?? "additional",
                parseString(additionalLimit.limit_name),
                additionalLimit,
            );
        }
    }

    return {
        planType: parseString(root.plan_type),
        limits,
        resetCredits: parseCodexRateLimitResetCreditsSummary(root.rate_limit_reset_credits),
        raw,
    };
}

export function parseCodexRateLimitResetCreditsPayload(
    payload: unknown,
): CodexRateLimitResetCredits | undefined {
    const root = JsonObjectDecoder.decode(payload);
    if (!root) return undefined;
    const availableCount = parseInteger(root.available_count);
    if (availableCount === undefined) return undefined;
    const rawCredits = JsonArrayDecoder.decode(root.credits) ?? [];
    const credits = rawCredits.flatMap((item) => {
        const credit = parseResetCredit(item);
        return credit ? [credit] : [];
    });
    return { availableCount, credits, raw: root };
}

export function formatCodexUsage(snapshot: CodexUsageSnapshot, clock: Clock = systemClock): string {
    const lines = [
        `Codex usage${snapshot.planType ? ` (${formatUsageTitle(snapshot.planType)})` : ""}:`,
    ];
    const rows = snapshot.limits.map((limit) => ({
        title: formatUsageTitle(limit.limitName ?? limit.limitId),
        usage: formatLimitUsage(limit, clock),
    }));
    const titleWidth = Math.max(0, ...rows.map((row) => row.title.length));
    for (const row of rows) {
        lines.push(`- ${`${row.title}:`.padEnd(titleWidth + 1)} ${row.usage}`);
    }
    if (snapshot.resetCredits) {
        lines.push(`- Resets available: ${snapshot.resetCredits.availableCount}`);
        lines.push(...formatResetCreditLines(snapshot.resetCredits, clock));
    }
    return lines.join("\n");
}

export function formatResetConsumeResult(result: CodexRateLimitResetConsumeResult): string {
    if (result.outcome === "reset") return "Codex rate limits reset.";
    if (result.outcome === "already_redeemed") return "Reset already applied; refreshed usage.";
    if (result.outcome === "nothing_to_reset") return "No active Codex limit to reset.";
    if (result.outcome === "no_credit") return "No banked resets available.";
    return "Reset response was not recognized; refresh usage before trying again.";
}

function formatResetCreditLines(resetCredits: CodexRateLimitResetCredits, clock: Clock): string[] {
    if (resetCredits.availableCount <= 0) return [];
    return resetCredits.credits
        .filter(isAvailableResetCredit)
        .map(resetCreditExpirationMs)
        .sort(compareResetCredits)
        .map(
            (expirationMs, index) =>
                `  - Reset ${index + 1}: ${formatResetCredit(expirationMs, clock)}`,
        );
}

function compareResetCredits(
    leftExpirationMs: number | undefined,
    rightExpirationMs: number | undefined,
): number {
    if (leftExpirationMs === undefined && rightExpirationMs === undefined) return 0;
    if (leftExpirationMs === undefined) return 1;
    if (rightExpirationMs === undefined) return -1;
    return leftExpirationMs - rightExpirationMs;
}

function formatResetCredit(expirationMs: number | undefined, clock: Clock): string {
    if (expirationMs === undefined) return "expiration unknown";
    return `expires ${formatExpiration(expirationMs, clock)}`;
}

function isAvailableResetCredit(credit: CodexRateLimitResetCredit): boolean {
    const status = credit.status?.toLowerCase();
    if (status !== undefined && status !== "available") return false;
    return credit.redeemedAt === undefined;
}

function resetCreditExpirationMs(credit: CodexRateLimitResetCredit): number | undefined {
    const explicitExpirationMs = parseTimestampMs(credit.expiresAt);
    if (explicitExpirationMs !== undefined) return explicitExpirationMs;
    const grantedAtMs = parseTimestampMs(credit.grantedAt);
    return grantedAtMs === undefined ? undefined : grantedAtMs + RESET_CREDIT_LIFETIME_MS;
}

function parseTimestampMs(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const timestampMs = Date.parse(value);
    return Number.isFinite(timestampMs) ? timestampMs : undefined;
}

function formatExpiration(timestampMs: number, clock: Clock): string {
    const absolute = new Date(timestampMs).toLocaleString();
    const remainingMs = timestampMs - clock.nowMs();
    if (remainingMs < 0) return `expired ${absolute}`;
    const minutes = Math.round(remainingMs / 60000);
    if (minutes < 90) return `in ~${minutes}m (${absolute})`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `in ~${hours}h (${absolute})`;
    const days = Math.round(hours / 24);
    return `in ~${days}d (${absolute})`;
}

async function buildCodexUsageHeaders(
    ctx: ExtensionContext,
    model: RuntimeModel,
): Promise<CodexResult<Headers>> {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
        return fail(
            new CodexAuthUnavailable({
                operation: "codexAuth",
                message: "OpenAI Codex auth is unavailable.",
                cause: auth.error,
            }),
        );
    }
    const headers = new Headers();
    applyProviderHeaders(headers, model.headers);
    applyProviderHeaders(headers, auth.headers);
    if (auth.apiKey) headers.set("authorization", `Bearer ${auth.apiKey}`);
    const token = auth.apiKey ?? extractBearerToken(headers);
    const accountId = token ? extractAccountId(token) : undefined;
    if (!headers.has("chatgpt-account-id") && accountId) {
        headers.set("chatgpt-account-id", accountId);
    }
    headers.set("accept", "application/json");
    headers.set("OAI-Language", "en");
    headers.set("originator", "pi");
    return ok(headers);
}

function applyProviderHeaders(
    headers: Headers,
    providerHeaders: ProviderHeaders | undefined,
): void {
    for (const [name, value] of Object.entries(providerHeaders ?? {})) {
        if (value === null) headers.delete(name);
        else headers.set(name, value);
    }
}

async function fetchCodexRateLimitResetCreditsWithHeaders(
    headers: Headers,
    modelBaseUrl: string | undefined,
    runtime: CodexRuntime,
    options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<CodexResult<CodexRateLimitResetCredits | undefined>> {
    const { signal } = options;
    if (signal?.aborted) {
        return fail(
            new CodexRequestCancelled({
                operation: "codexUsage",
                message: "Codex usage request was cancelled.",
                cause: signal.reason,
            }),
        );
    }
    const creditsUrl = buildCodexRateLimitResetCreditsUrl(modelBaseUrl);
    const accountId = headers.get("chatgpt-account-id")?.trim();
    const cacheKey = accountId && accountId.length > 0 ? `${creditsUrl}:${accountId}` : undefined;
    if (
        cacheKey &&
        resetCreditsCache &&
        resetCreditsCache.key === cacheKey &&
        resetCreditsCache.expiresAt > runtime.clock.nowMs()
    ) {
        return ok(resetCreditsCache.credits);
    }
    // Cold requests remain caller-owned: overlapping callers may each perform a GET.
    // Only settled data is shared; expiry remains anchored to this request's start.
    const generation = resetCreditsCacheGeneration;
    const expiresAt = runtime.clock.nowMs() + RESET_CREDITS_CACHE_MS;
    const requestInit: RequestInit = { method: "GET", headers };
    if (signal) requestInit.signal = signal;
    const response = await fetchUsageResponse(runtime, creditsUrl, requestInit);
    if (response.isErr()) return response;
    if (!response.value.ok) return ok(undefined);
    const rawCreditsPayload = await parseJsonResponse(response.value, "codexResetCredits");
    if (rawCreditsPayload.isErr()) return rawCreditsPayload;
    const credits = parseCodexRateLimitResetCreditsPayload(rawCreditsPayload.value);
    if (
        cacheKey &&
        credits &&
        !signal?.aborted &&
        generation === resetCreditsCacheGeneration &&
        expiresAt > runtime.clock.nowMs()
    ) {
        resetCreditsCache = { key: cacheKey, expiresAt, credits };
    }
    return ok(credits);
}

async function fetchUsageResponse(
    runtime: CodexRuntime,
    url: string,
    init: RequestInit,
): Promise<CodexResult<Response>> {
    try {
        return ok(await runtime.fetch(url, init));
    } catch (cause: unknown) {
        if (isAbortCause(cause)) {
            return fail(
                new CodexRequestCancelled({
                    operation: "codexUsage",
                    message: "Codex usage request was cancelled.",
                    cause,
                }),
            );
        }
        return fail(
            new CodexNetworkUnavailable({
                operation: "codexUsage",
                provider: "openai-codex",
                message: "Codex usage network request failed.",
                cause,
            }),
        );
    }
}

async function parseJsonResponse(
    response: Response,
    operation: "codexUsage" | "codexResetCredit" | "codexResetCredits",
): Promise<CodexResult<JsonValue>> {
    const text = await response.text();
    try {
        const parsed: unknown = JSON.parse(text);
        const value = JsonValueDecoder.decode(parsed);
        if (value === undefined) throw new SyntaxError("Response is not valid JSON data.");
        return ok(value);
    } catch (cause: unknown) {
        return fail(
            new CodexInvalidJson({
                operation,
                provider: "openai-codex",
                message: "Codex response was not valid JSON.",
                cause,
            }),
        );
    }
}

function requireOpenAICodexModel(model: ExtensionContext["model"]): CodexResult<RuntimeModel> {
    if (!isModelWithStringApi(model)) {
        return fail(
            new CodexUnsupportedModel({
                operation: "codexUsage",
                message: "No active model selected.",
            }),
        );
    }
    if (model.provider !== "openai-codex") {
        return fail(
            new CodexUnsupportedModel({
                operation: "codexUsage",
                message:
                    "Codex usage and reset credits are only available for OpenAI Codex subscription models.",
            }),
        );
    }
    return ok(model);
}

function parseCodexRateLimitResetConsumePayload(
    payload: unknown,
): CodexRateLimitResetConsumeResult {
    const raw = JsonValueDecoder.decode(payload);
    const root = JsonObjectDecoder.decode(raw) ?? {};
    const code = parseString(root.code);
    const outcome: CodexRateLimitResetConsumeOutcome =
        code === "reset" ||
        code === "already_redeemed" ||
        code === "nothing_to_reset" ||
        code === "no_credit"
            ? code
            : "unknown";
    return { outcome, windowsReset: parseInteger(root.windows_reset), raw };
}

function parseCodexRateLimitResetCreditsSummary(
    value: JsonValue | undefined,
): CodexRateLimitResetCredits | undefined {
    const summary = JsonObjectDecoder.decode(value);
    if (!summary) return undefined;
    const availableCount = parseInteger(summary.available_count);
    return availableCount === undefined ? undefined : { availableCount, credits: [], raw: summary };
}

function parseResetCredit(value: JsonValue): CodexRateLimitResetCredit | undefined {
    const credit = JsonObjectDecoder.decode(value);
    if (!credit) return undefined;
    return {
        id: parseString(credit.id),
        resetType: parseString(credit.reset_type),
        status: parseString(credit.status),
        grantedAt: parseString(credit.granted_at),
        expiresAt: parseString(credit.expires_at),
        redeemStartedAt: parseString(credit.redeem_started_at),
        redeemedAt: parseString(credit.redeemed_at),
        title: parseString(credit.title),
        description: parseString(credit.description),
    };
}

type ParsedRateLimit = {
    readonly primary?: CodexUsageWindow | undefined;
    readonly secondary?: CodexUsageWindow | undefined;
};

function parseRateLimit(value: JsonValue | undefined): ParsedRateLimit {
    const rateLimit = JsonObjectDecoder.decode(value);
    if (!rateLimit) return {};
    return {
        primary: parseWindow(rateLimit.primary_window) ?? parseWindow(rateLimit.primary),
        secondary: parseWindow(rateLimit.secondary_window) ?? parseWindow(rateLimit.secondary),
    };
}

function parseWindow(value: JsonValue | undefined): CodexUsageWindow | undefined {
    const window = JsonObjectDecoder.decode(value);
    if (!window) return undefined;
    const usedPercent = JsonNumberDecoder.decode(window.used_percent);
    const limitWindowSeconds = JsonNumberDecoder.decode(window.limit_window_seconds);
    const windowMinutes =
        JsonNumberDecoder.decode(window.window_minutes) ??
        (limitWindowSeconds === undefined ? undefined : Math.ceil(limitWindowSeconds / 60));
    const resetsAt =
        JsonNumberDecoder.decode(window.resets_at) ?? JsonNumberDecoder.decode(window.reset_at);
    return usedPercent === undefined && windowMinutes === undefined && resetsAt === undefined
        ? undefined
        : { usedPercent, windowMinutes, resetsAt };
}

function formatLimitUsage(limit: CodexUsageLimit, clock: Clock): string {
    const parts = [
        formatWindow("5h", limit.primary, clock),
        formatWindow("weekly", limit.secondary, clock),
    ].filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join("; ") : "no usage data";
}

function formatWindow(
    label: string,
    window: CodexUsageWindow | undefined,
    clock: Clock,
): string | undefined {
    if (!window) return undefined;
    const remainingPercent =
        window.usedPercent === undefined
            ? undefined
            : 100 - Math.max(0, Math.min(100, window.usedPercent));
    const percent = remainingPercent === undefined ? "?" : `${Math.round(remainingPercent)}%`;
    const left = `${percent} left`.padEnd("100% left".length);
    return `${label}: ${left} (${formatReset(window.resetsAt, clock)})`;
}

function formatUsageTitle(value: string): string {
    return value
        .trim()
        .split(/([\s_-]+)/)
        .map((part) => {
            if (/^[\s_-]+$/.test(part)) return part.includes("_") ? " " : part;
            return formatUsageTitleWord(part);
        })
        .join("");
}

function formatUsageTitleWord(value: string): string {
    const lower = value.toLowerCase();
    if (lower === "gpt") return "GPT";
    if (lower === "codex") return "Codex";
    if (lower.length === 0) return value;
    return `${lower[0]?.toUpperCase() ?? ""}${lower.slice(1)}`;
}

function formatReset(timestampSeconds: number | undefined, clock: Clock): string {
    if (!timestampSeconds) return "reset unknown";
    const minutes = Math.max(0, Math.round((timestampSeconds * 1000 - clock.nowMs()) / 60000));
    return minutes < 90
        ? `resets in ~${minutes}m`
        : `resets ${new Date(timestampSeconds * 1000).toLocaleString()}`;
}

function extractBearerToken(headers: Headers): string | undefined {
    const authorization = headers.get("authorization")?.trim();
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim();
}

function parseString(value: JsonValue | undefined): string | undefined {
    const parsed = StringSchema.decode(value);
    if (parsed === undefined) return undefined;
    const text = parsed.trim();
    return text.length > 0 ? text : undefined;
}

function parseInteger(value: JsonValue | undefined): number | undefined {
    const numericValue = JsonNumberDecoder.decode(value);
    if (numericValue !== undefined) return Math.max(0, Math.trunc(numericValue));
    const text = StringSchema.decode(value)?.trim();
    if (!text) return undefined;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : undefined;
}
