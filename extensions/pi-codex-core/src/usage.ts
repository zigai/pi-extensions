import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { extractAccountId } from "./codex-auth.ts";
import { compileSchema, parseWithSchema } from "./schema-parsing.ts";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
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
    resetCredits?: CodexRateLimitResetCredits | undefined;
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
          readonly promise: Promise<CodexRateLimitResetCredits | undefined>;
      }
    | undefined;

export function buildCodexUsageUrl(): string {
    return `${DEFAULT_CODEX_BASE_URL}/wham/usage`;
}

export function buildCodexRateLimitResetCreditsUrl(): string {
    return `${DEFAULT_CODEX_BASE_URL}/wham/rate-limit-reset-credits`;
}

export function buildCodexRateLimitResetConsumeUrl(): string {
    return `${DEFAULT_CODEX_BASE_URL}/wham/rate-limit-reset-credits/consume`;
}

export async function fetchCodexUsage(ctx: ExtensionContext): Promise<CodexUsageSnapshot> {
    const model = requireOpenAICodexModel(ctx.model);
    const headers = await buildCodexUsageHeaders(ctx, model);
    const response = await fetch(buildCodexUsageUrl(), {
        method: "GET",
        headers,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const text = await response.text();
    if (!response.ok)
        throw new Error(
            `Usage request failed (${response.status}): ${text || response.statusText}`,
        );
    const rawUsagePayload: unknown = JSON.parse(text);
    const snapshot = parseCodexUsagePayload(rawUsagePayload);
    if (!snapshot.resetCredits || snapshot.resetCredits.availableCount > 0) {
        try {
            const detailedResetCredits = await fetchCodexRateLimitResetCreditsWithHeaders(
                headers,
                ctx.signal,
            );
            if (detailedResetCredits) snapshot.resetCredits = detailedResetCredits;
        } catch {
            // Detailed reset-credit metadata is additive; usage still renders if this endpoint fails.
        }
    }
    return snapshot;
}

export function createCodexRateLimitResetRedeemRequestId(): string {
    return globalThis.crypto.randomUUID();
}

export async function consumeCodexRateLimitResetCredit(
    ctx: ExtensionContext,
    redeemRequestId = createCodexRateLimitResetRedeemRequestId(),
): Promise<CodexRateLimitResetConsumeResult> {
    const model = requireOpenAICodexModel(ctx.model);
    const headers = await buildCodexUsageHeaders(ctx, model);
    headers.set("content-type", "application/json");
    resetCreditsCache = undefined;
    const response = await fetch(buildCodexRateLimitResetConsumeUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify({ redeem_request_id: redeemRequestId }),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const text = await response.text();
    if (!response.ok)
        throw new Error(
            `Reset request failed (${response.status}): ${text || response.statusText}`,
        );
    resetCreditsCache = undefined;
    const rawConsumePayload: unknown = JSON.parse(text);
    return parseCodexRateLimitResetConsumePayload(rawConsumePayload);
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
): Promise<Headers> {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(auth.error);
    const headers = new Headers(model.headers);
    for (const [key, value] of Object.entries(auth.headers ?? {})) headers.set(key, value);
    if (auth.apiKey) headers.set("authorization", `Bearer ${auth.apiKey}`);
    const token = auth.apiKey ?? extractBearerToken(headers);
    const accountId = token ? extractAccountId(token) : undefined;
    if (accountId) headers.set("chatgpt-account-id", accountId);
    headers.set("accept", "application/json");
    headers.set("OAI-Language", "en");
    headers.set("originator", "pi");
    return headers;
}

async function fetchCodexRateLimitResetCreditsWithHeaders(
    headers: Headers,
    signal?: AbortSignal,
): Promise<CodexRateLimitResetCredits | undefined> {
    const accountId = headers.get("chatgpt-account-id")?.trim();
    const cacheKey = accountId && accountId.length > 0 ? accountId : undefined;
    if (
        cacheKey &&
        resetCreditsCache &&
        resetCreditsCache.key === cacheKey &&
        resetCreditsCache.expiresAt > Date.now()
    ) {
        return resetCreditsCache.promise;
    }
    const promise = (async () => {
        const response = await fetch(buildCodexRateLimitResetCreditsUrl(), {
            method: "GET",
            headers,
            ...(signal ? { signal } : {}),
        });
        if (!response.ok) return undefined;
        const rawCreditsPayload: unknown = JSON.parse(await response.text());
        return parseCodexRateLimitResetCreditsPayload(rawCreditsPayload);
    })();
    if (cacheKey)
        resetCreditsCache = {
            key: cacheKey,
            expiresAt: Date.now() + RESET_CREDITS_CACHE_MS,
            promise,
        };
    return promise;
}

function requireOpenAICodexModel(model: ExtensionContext["model"]): RuntimeModel {
    if (!model) throw new Error("No active model selected.");
    if (model.provider !== "openai-codex") {
        throw new Error(
            "Codex usage and reset credits are only available for OpenAI Codex subscription models.",
        );
    }
    return model as RuntimeModel;
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
    const minutes = Math.max(0, Math.round((timestampSeconds * 1000 - Date.now()) / 60000));
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
