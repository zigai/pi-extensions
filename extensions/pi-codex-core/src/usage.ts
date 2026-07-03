import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { extractAccountId, resolveCodexApiProviderBaseUrl } from "./codex-auth.ts";
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
import { defaultCodexRuntime, type CodexRuntime, type IdGenerator } from "./runtime.ts";
import { compileSchema, parseWithSchema } from "./schema-parsing.ts";

const RESET_CREDITS_CACHE_MS = 5_000;

type RuntimeModel = Model<Api>;

const UnknownRecordSchema = compileSchema(Type.Record(Type.String(), Type.Unknown()));
const StringSchema = compileSchema(Type.String());
const NumberSchema = compileSchema(Type.Number());
const ResetCreditSchema = compileSchema(
    Type.Object({
        id: Type.Optional(Type.String()),
        reset_type: Type.Optional(Type.String()),
        status: Type.Optional(Type.String()),
        granted_at: Type.Optional(Type.String()),
        expires_at: Type.Optional(Type.String()),
        redeem_started_at: Type.Optional(Type.String()),
        redeemed_at: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
    }),
);

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
    readonly raw: unknown;
};

export type CodexUsageSnapshot = {
    readonly planType?: string | undefined;
    readonly limits: readonly CodexUsageLimit[];
    readonly resetCredits?: CodexRateLimitResetCredits | undefined;
    readonly raw: unknown;
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
    readonly raw: unknown;
};

let resetCreditsCache:
    | {
          readonly key: string;
          readonly expiresAt: number;
          readonly promise: Promise<CodexResult<CodexRateLimitResetCredits | undefined>>;
      }
    | undefined;

export function buildCodexUsageUrl(modelBaseUrl?: string | undefined): string {
    return `${resolveCodexWhamBaseUrl(modelBaseUrl)}/wham/usage`;
}

export function buildCodexRateLimitResetCreditsUrl(modelBaseUrl?: string | undefined): string {
    return `${resolveCodexWhamBaseUrl(modelBaseUrl)}/wham/rate-limit-reset-credits`;
}

export function buildCodexRateLimitResetConsumeUrl(modelBaseUrl?: string | undefined): string {
    return `${resolveCodexWhamBaseUrl(modelBaseUrl)}/wham/rate-limit-reset-credits/consume`;
}

function resolveCodexWhamBaseUrl(modelBaseUrl: string | undefined): string {
    const codexBaseUrl = resolveCodexApiProviderBaseUrl(modelBaseUrl);
    return codexBaseUrl.endsWith("/codex")
        ? codexBaseUrl.slice(0, -"/codex".length)
        : codexBaseUrl;
}

export type CodexUsageOptions = {
    readonly runtime?: CodexRuntime | undefined;
};

export async function fetchCodexUsage(
    ctx: ExtensionContext,
    options: CodexUsageOptions = {},
): Promise<CodexResult<CodexUsageSnapshot>> {
    const runtime = options.runtime ?? defaultCodexRuntime;
    const model = requireOpenAICodexModel(ctx.model);
    if (model.isErr()) return model;
    const headers = await buildCodexUsageHeaders(ctx, model.value);
    if (headers.isErr()) return headers;

    const response = await fetchUsageResponse(runtime, buildCodexUsageUrl(model.value.baseUrl), {
        method: "GET",
        headers: headers.value,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
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
        ctx.signal,
        runtime,
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
    const model = requireOpenAICodexModel(ctx.model);
    if (model.isErr()) return model;
    const headers = await buildCodexUsageHeaders(ctx, model.value);
    if (headers.isErr()) return headers;
    headers.value.set("content-type", "application/json");
    resetCreditsCache = undefined;

    const response = await fetchUsageResponse(
        runtime,
        buildCodexRateLimitResetConsumeUrl(model.value.baseUrl),
        {
            method: "POST",
            headers: headers.value,
            body: JSON.stringify({ redeem_request_id: redeemRequestId }),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
        },
    );
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

    resetCreditsCache = undefined;
    const rawConsumePayload = await parseJsonResponse(response.value, "codexResetCredit");
    if (rawConsumePayload.isErr()) return rawConsumePayload;
    return ok(parseCodexRateLimitResetConsumePayload(rawConsumePayload.value));
}

export function parseCodexUsagePayload(payload: unknown): CodexUsageSnapshot {
    const root = parseUsageRecord(payload) ?? {};
    const limits: CodexUsageLimit[] = [];
    const addLimit = (limitId: string, limitName: string | undefined, source: unknown): void => {
        const sourceRecord = parseUsageRecord(source);
        const rateLimit =
            sourceRecord && "rate_limit" in sourceRecord ? sourceRecord.rate_limit : source;
        const parsed = parseRateLimit(rateLimit);
        limits.push({
            limitId,
            ...(limitName ? { limitName } : {}),
            ...(parsed.primary ? { primary: parsed.primary } : {}),
            ...(parsed.secondary ? { secondary: parsed.secondary } : {}),
        });
    };

    addLimit("codex", undefined, root.rate_limit);
    if (Array.isArray(root.additional_rate_limits)) {
        for (const item of root.additional_rate_limits) {
            const additionalLimit = parseUsageRecord(item);
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
        raw: payload,
    };
}

export function parseCodexRateLimitResetCreditsPayload(
    payload: unknown,
): CodexRateLimitResetCredits | undefined {
    const root = parseUsageRecord(payload);
    if (!root) return undefined;
    const availableCount = parseInteger(root.available_count);
    if (availableCount === undefined) return undefined;
    const credits = Array.isArray(root.credits)
        ? root.credits.flatMap((item) => {
              const credit = parseResetCredit(item);
              return credit ? [credit] : [];
          })
        : [];
    return { availableCount, credits, raw: payload };
}

export function formatCodexUsage(snapshot: CodexUsageSnapshot): string {
    const lines = [
        `Codex usage${snapshot.planType ? ` (${formatUsageTitle(snapshot.planType)})` : ""}:`,
    ];
    const rows = snapshot.limits.map((limit) => ({
        title: formatUsageTitle(limit.limitName ?? limit.limitId),
        usage: formatLimitUsage(limit),
    }));
    const titleWidth = Math.max(0, ...rows.map((row) => row.title.length));
    for (const row of rows) {
        lines.push(`- ${`${row.title}:`.padEnd(titleWidth + 1)} ${row.usage}`);
    }
    if (snapshot.resetCredits)
        lines.push(`- Resets available: ${snapshot.resetCredits.availableCount}`);
    return lines.join("\n");
}

export function formatResetConsumeResult(result: CodexRateLimitResetConsumeResult): string {
    if (result.outcome === "reset") return "Codex rate limits reset.";
    if (result.outcome === "already_redeemed") return "Reset already applied; refreshed usage.";
    if (result.outcome === "nothing_to_reset") return "No active Codex limit to reset.";
    if (result.outcome === "no_credit") return "No banked resets available.";
    return "Reset response was not recognized; refresh usage before trying again.";
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
    const headers = new Headers(model.headers);
    for (const [key, value] of Object.entries(auth.headers ?? {})) headers.set(key, value);
    if (auth.apiKey) headers.set("authorization", `Bearer ${auth.apiKey}`);
    const token = auth.apiKey ?? extractBearerToken(headers);
    const accountId = token ? extractAccountId(token) : undefined;
    if (accountId) headers.set("chatgpt-account-id", accountId);
    headers.set("accept", "application/json");
    headers.set("OAI-Language", "en");
    headers.set("originator", "pi");
    return ok(headers);
}

async function fetchCodexRateLimitResetCreditsWithHeaders(
    headers: Headers,
    modelBaseUrl: string | undefined,
    signal: AbortSignal | undefined,
    runtime: CodexRuntime,
): Promise<CodexResult<CodexRateLimitResetCredits | undefined>> {
    const creditsUrl = buildCodexRateLimitResetCreditsUrl(modelBaseUrl);
    const accountId = headers.get("chatgpt-account-id")?.trim();
    const cacheKey = accountId && accountId.length > 0 ? `${creditsUrl}:${accountId}` : undefined;
    if (
        cacheKey &&
        resetCreditsCache &&
        resetCreditsCache.key === cacheKey &&
        resetCreditsCache.expiresAt > runtime.clock.nowMs()
    ) {
        return resetCreditsCache.promise;
    }
    const promise = (async (): Promise<CodexResult<CodexRateLimitResetCredits | undefined>> => {
        const response = await fetchUsageResponse(runtime, creditsUrl, {
            method: "GET",
            headers,
            ...(signal ? { signal } : {}),
        });
        if (response.isErr()) return response;
        if (!response.value.ok) return ok(undefined);
        const rawCreditsPayload = await parseJsonResponse(response.value, "codexResetCredits");
        if (rawCreditsPayload.isErr()) return rawCreditsPayload;
        return ok(parseCodexRateLimitResetCreditsPayload(rawCreditsPayload.value));
    })();
    if (cacheKey)
        resetCreditsCache = {
            key: cacheKey,
            expiresAt: runtime.clock.nowMs() + RESET_CREDITS_CACHE_MS,
            promise,
        };
    return promise;
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
): Promise<CodexResult<unknown>> {
    const text = await response.text();
    try {
        return ok(JSON.parse(text) as unknown);
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
    if (!model) {
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
    return ok(model as RuntimeModel);
}

function parseCodexRateLimitResetConsumePayload(
    payload: unknown,
): CodexRateLimitResetConsumeResult {
    const root = parseUsageRecord(payload) ?? {};
    const code = parseString(root.code);
    const outcome: CodexRateLimitResetConsumeOutcome =
        code === "reset" ||
        code === "already_redeemed" ||
        code === "nothing_to_reset" ||
        code === "no_credit"
            ? code
            : "unknown";
    return { outcome, windowsReset: parseInteger(root.windows_reset), raw: payload };
}

function parseCodexRateLimitResetCreditsSummary(
    value: unknown,
): CodexRateLimitResetCredits | undefined {
    const summary = parseUsageRecord(value);
    if (!summary) return undefined;
    const availableCount = parseInteger(summary.available_count);
    return availableCount === undefined ? undefined : { availableCount, credits: [], raw: value };
}

function parseResetCredit(value: unknown): CodexRateLimitResetCredit | undefined {
    const credit = parseWithSchema(ResetCreditSchema, value);
    if (!credit) return undefined;
    return {
        id: credit.id,
        resetType: credit.reset_type,
        status: credit.status,
        grantedAt: credit.granted_at,
        expiresAt: credit.expires_at,
        redeemStartedAt: credit.redeem_started_at,
        redeemedAt: credit.redeemed_at,
        title: credit.title,
        description: credit.description,
    };
}

function parseRateLimit(value: unknown): {
    readonly primary?: CodexUsageWindow | undefined;
    readonly secondary?: CodexUsageWindow | undefined;
} {
    const rateLimit = parseUsageRecord(value);
    if (!rateLimit) return {};
    return {
        primary: parseWindow(rateLimit.primary_window) ?? parseWindow(rateLimit.primary),
        secondary: parseWindow(rateLimit.secondary_window) ?? parseWindow(rateLimit.secondary),
    };
}

function parseWindow(value: unknown): CodexUsageWindow | undefined {
    const window = parseUsageRecord(value);
    if (!window) return undefined;
    const usedPercent = parseNumber(window.used_percent);
    const limitWindowSeconds = parseNumber(window.limit_window_seconds);
    const windowMinutes =
        parseNumber(window.window_minutes) ??
        (limitWindowSeconds === undefined ? undefined : Math.ceil(limitWindowSeconds / 60));
    const resetsAt = parseNumber(window.resets_at) ?? parseNumber(window.reset_at);
    return usedPercent === undefined && windowMinutes === undefined && resetsAt === undefined
        ? undefined
        : { usedPercent, windowMinutes, resetsAt };
}

function formatLimitUsage(limit: CodexUsageLimit): string {
    const parts = [
        formatWindow("5h", limit.primary),
        formatWindow("weekly", limit.secondary),
    ].filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join("; ") : "no usage data";
}

function formatWindow(label: string, window: CodexUsageWindow | undefined): string | undefined {
    if (!window) return undefined;
    const remainingPercent =
        window.usedPercent === undefined
            ? undefined
            : 100 - Math.max(0, Math.min(100, window.usedPercent));
    const percent = remainingPercent === undefined ? "?" : `${Math.round(remainingPercent)}%`;
    const left = `${percent} left`.padEnd("100% left".length);
    return `${label}: ${left} (${formatReset(window.resetsAt)})`;
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

function formatReset(timestampSeconds: number | undefined): string {
    if (!timestampSeconds) return "reset unknown";
    const minutes = Math.max(
        0,
        Math.round((timestampSeconds * 1000 - defaultCodexRuntime.clock.nowMs()) / 60000),
    );
    return minutes < 90
        ? `resets in ~${minutes}m`
        : `resets ${new Date(timestampSeconds * 1000).toLocaleString()}`;
}

function extractBearerToken(headers: Headers): string | undefined {
    const authorization = headers.get("authorization")?.trim();
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim();
}

function parseString(value: unknown): string | undefined {
    const parsed = parseWithSchema(StringSchema, value);
    if (parsed === undefined) return undefined;
    const text = parsed.trim();
    return text.length > 0 ? text : undefined;
}

function parseNumber(value: unknown): number | undefined {
    return parseWithSchema(NumberSchema, value);
}

function parseInteger(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : undefined;
}

function parseUsageRecord(value: unknown): Record<string, unknown> | undefined {
    return parseWithSchema(UnknownRecordSchema, value);
}
