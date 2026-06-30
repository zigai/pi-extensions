import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const CODEX_ORIGINATOR = "codex_cli_rs";
const OPENAI_CODEX_PROVIDER = "openai-codex";

export type CodexToolProvider = {
    readonly baseUrl: string;
    readonly model: string;
    readonly token: string;
    readonly accountId: string;
};

export type CodexResponsesProvider = CodexToolProvider & {
    readonly provider: string;
    readonly api: string;
    readonly responsesUrl: string;
    readonly headers: Headers;
};

type RuntimeModel = Model<Api>;

export function resolveCodexApiProviderBaseUrl(modelBaseUrl: string | undefined): string {
    const trimmedBaseUrl = modelBaseUrl?.trim();
    const rawBase =
        trimmedBaseUrl && trimmedBaseUrl.length > 0 ? trimmedBaseUrl : DEFAULT_CODEX_BASE_URL;
    const normalized = rawBase.replace(/\/+$/, "");
    try {
        const url = new URL(normalized);
        if (url.pathname === "" || url.pathname === "/") return `${normalized}/api/codex`;
    } catch {
        return normalized;
    }
    if (normalized.endsWith("/codex/responses")) return normalized.slice(0, -"/responses".length);
    if (normalized.endsWith("/codex")) return normalized;
    if (normalized.endsWith("/backend-api") || normalized.endsWith("/api"))
        return `${normalized}/codex`;
    return normalized;
}

export function resolveCodexResponsesUrl(providerBaseUrl: string): string {
    const normalized = providerBaseUrl.replace(/\/+$/, "");
    if (normalized.endsWith("/codex/responses")) return normalized;
    return `${resolveCodexApiProviderBaseUrl(normalized)}/responses`;
}

export function codexToolProviderHeaders(provider: CodexToolProvider): Headers {
    const headers = new Headers();
    headers.set("Authorization", `Bearer ${provider.token}`);
    headers.set("ChatGPT-Account-ID", provider.accountId);
    headers.set("originator", CODEX_ORIGINATOR);
    headers.set("User-Agent", codexUserAgent(CODEX_ORIGINATOR));
    headers.set("version", "0.0.0");
    headers.set("content-type", "application/json");
    return headers;
}

export function codexUserAgent(originator: string = CODEX_ORIGINATOR): string {
    const platform =
        process.platform === "darwin"
            ? "Mac OS"
            : process.platform === "win32"
              ? "Windows"
              : process.platform;
    const termProgram = process.env.TERM_PROGRAM?.trim();
    const term = process.env.TERM?.trim();
    const terminal =
        termProgram && termProgram.length > 0
            ? termProgram
            : term && term.length > 0
              ? term
              : "unknown";
    return `${originator}/0.0.0 (${platform} unknown; ${process.arch}) ${terminal}`;
}

export async function resolveCodexToolProvider(ctx: ExtensionContext): Promise<CodexToolProvider> {
    return resolveCodexProviderForModel(ctx, resolveCodexToolAuthModel(ctx), {
        tokenUnavailableMessage:
            "Codex tools require /login openai-codex or an OpenAI Codex-compatible token.",
    });
}

/** Resolve the active OpenAI Codex responses provider and prepared response headers. */
export async function resolveActiveCodexResponsesProvider(
    ctx: ExtensionContext,
): Promise<CodexResponsesProvider | undefined> {
    const model = ctx.model;
    if (!isUsableOpenAICodexModel(model)) return undefined;
    const provider = await resolveCodexProviderForModel(ctx, model, {
        tokenUnavailableMessage: "OpenAI Codex auth is unavailable.",
        requireAccountId: true,
    });
    const headers = codexToolProviderHeaders(provider);
    headers.set("OpenAI-Beta", "responses=experimental");
    return {
        ...provider,
        provider: model.provider,
        api: model.api,
        responsesUrl: resolveCodexResponsesUrl(provider.baseUrl),
        headers,
    };
}

export function extractAccountId(token: string): string | undefined {
    try {
        const parts = token.split(".");
        const payloadPart = parts[1];
        if (parts.length !== 3 || !payloadPart) return undefined;
        const payload = JSON.parse(
            Buffer.from(payloadPart, "base64url").toString("utf8"),
        ) as unknown;
        if (!isRecord(payload)) return undefined;
        const authClaims = payload[JWT_CLAIM_PATH];
        if (!isRecord(authClaims)) return undefined;
        const accountId = authClaims.chatgpt_account_id;
        return typeof accountId === "string" && accountId.trim().length > 0
            ? accountId.trim()
            : undefined;
    } catch {
        return undefined;
    }
}

async function resolveCodexProviderForModel(
    ctx: ExtensionContext,
    model: RuntimeModel,
    options: { readonly tokenUnavailableMessage: string; readonly requireAccountId?: boolean },
): Promise<CodexToolProvider> {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(auth.error);

    const token =
        auth.apiKey ?? headerValue(auth.headers, "Authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) throw new Error(options.tokenUnavailableMessage);

    const accountId = headerValue(auth.headers, "chatgpt-account-id") ?? extractAccountId(token);
    if (options.requireAccountId && !accountId)
        throw new Error("OpenAI Codex account id is unavailable.");

    return {
        baseUrl: resolveCodexApiProviderBaseUrl(model.baseUrl),
        model: model.id,
        token,
        accountId: accountId ?? "",
    };
}

function resolveCodexToolAuthModel(ctx: ExtensionContext): RuntimeModel {
    if (isUsableOpenAICodexModel(ctx.model)) return ctx.model as RuntimeModel;

    const registry = ctx.modelRegistry as {
        readonly find?: (provider: string, modelId: string) => RuntimeModel | undefined;
        readonly getAvailable?: () => RuntimeModel[];
        readonly getAll?: () => RuntimeModel[];
    };

    const currentId = ctx.model?.id;
    const direct = currentId ? registry.find?.(OPENAI_CODEX_PROVIDER, currentId) : undefined;
    if (isUsableOpenAICodexModel(direct)) return direct;

    for (const modelId of ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"]) {
        const model = registry.find?.(OPENAI_CODEX_PROVIDER, modelId);
        if (isUsableOpenAICodexModel(model)) return model;
    }

    const availableModel = registry.getAvailable?.().find(isUsableOpenAICodexModel);
    if (availableModel) return availableModel;

    const registeredModel = registry.getAll?.().find(isUsableOpenAICodexModel);
    if (registeredModel) return registeredModel;

    throw new Error(
        "Codex tools require /login openai-codex or an available OpenAI Codex Responses model.",
    );
}

function isUsableOpenAICodexModel(
    model: ExtensionContext["model"] | undefined,
): model is RuntimeModel {
    return (
        (model?.provider ?? "").trim().toLowerCase() === OPENAI_CODEX_PROVIDER &&
        Boolean(model?.api?.includes("responses"))
    );
}

function headerValue(
    headers: Record<string, string> | undefined,
    name: string,
): string | undefined {
    if (!headers) return undefined;
    const lowerName = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === lowerName && value.trim().length > 0) return value;
    }
    return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
