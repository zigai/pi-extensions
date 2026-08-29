import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
    CodexAuthUnavailable,
    CodexUnsupportedModel,
    fail,
    ok,
    type CodexResult,
} from "./failures.ts";
import { Redacted } from "./redacted.ts";
import { compileSchema, StringDecoder } from "../schema-parsing.ts";
import { CODEX_TEXT_MODEL_CHOICES } from "./models.ts";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const CODEX_ORIGINATOR = "codex_cli_rs";
const OPENAI_CODEX_PROVIDER = "openai-codex";
const PI_CODEX_CORE_VERSION = "0.1.0";

export type CodexToolProvider = {
    readonly baseUrl: string;
    readonly model: string;
    readonly token?: Redacted<string> | undefined;
    readonly accountId: string;
    readonly redactedHeaders?: Readonly<Record<string, Redacted<string>>> | undefined;
};

type CodexToolProviderConstruction = {
    -readonly [Key in keyof CodexToolProvider]: CodexToolProvider[Key];
};

export type CodexResponsesProvider = CodexToolProvider & {
    readonly provider: string;
    readonly api: string;
    readonly responsesUrl: string;
    readonly headers: Headers;
};

type RuntimeModel = Model<Api>;

const JwtPayloadSchema = compileSchema(
    Type.Object({
        [JWT_CLAIM_PATH]: Type.Optional(
            Type.Object({ chatgpt_account_id: Type.Optional(Type.String()) }),
        ),
    }),
);

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
    for (const [name, value] of Object.entries(provider.redactedHeaders ?? {})) {
        headers.set(name, value.reveal());
    }
    if (provider.token) headers.set("Authorization", `Bearer ${provider.token.reveal()}`);
    if (provider.accountId.trim().length > 0) {
        headers.set("ChatGPT-Account-ID", provider.accountId);
    }
    headers.set("originator", CODEX_ORIGINATOR);
    headers.set("User-Agent", codexUserAgent(CODEX_ORIGINATOR));
    headers.delete("version");
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
    return `${originator}/${PI_CODEX_CORE_VERSION} (${platform} unknown; ${process.arch}) ${terminal}`;
}

export async function resolveCodexToolProvider(
    ctx: ExtensionContext,
    options: { readonly requireAccountId?: boolean; readonly useActiveModel?: boolean } = {},
): Promise<CodexResult<CodexToolProvider>> {
    const model = options.useActiveModel
        ? resolveActiveCompatibleToolModel(ctx)
        : resolveCodexToolAuthModel(ctx);
    if (model.isErr()) return model;
    return resolveCodexProviderForModel(ctx, model.value, {
        requireAccountId:
            options.requireAccountId ??
            isChatGptBackend(model.value.baseUrl ?? DEFAULT_CODEX_BASE_URL),
        tokenUnavailableMessage:
            "Codex tools require /login openai-codex or an OpenAI Codex-compatible token.",
    });
}

function isChatGptBackend(baseUrl: string): boolean {
    try {
        return new URL(baseUrl).hostname.toLowerCase() === "chatgpt.com";
    } catch {
        return false;
    }
}

function resolveActiveCompatibleToolModel(ctx: ExtensionContext): CodexResult<RuntimeModel> {
    const model = ctx.model;
    if (isModelWithStringApi(model) && model.api.toLowerCase().includes("responses")) {
        return ok(model);
    }
    return fail(
        new CodexUnsupportedModel({
            operation: "codexAuth",
            message: "Codex tools require an active OpenAI-compatible Responses model.",
        }),
    );
}

/** Resolve the active OpenAI Codex responses provider and prepared response headers. */
export async function resolveActiveCodexResponsesProvider(
    ctx: ExtensionContext,
): Promise<CodexResult<CodexResponsesProvider | undefined>> {
    const model = ctx.model;
    if (!isUsableOpenAICodexModel(model)) return ok(undefined);
    const provider = await resolveCodexProviderForModel(ctx, model, {
        tokenUnavailableMessage: "OpenAI Codex auth is unavailable.",
        requireAccountId: true,
    });
    if (provider.isErr()) return provider;
    const headers = codexToolProviderHeaders(provider.value);
    headers.set("OpenAI-Beta", "responses=experimental");
    return ok({
        ...provider.value,
        provider: model.provider,
        api: model.api,
        responsesUrl: resolveCodexResponsesUrl(provider.value.baseUrl),
        headers,
    });
}

export function extractAccountId(token: string): string | undefined {
    try {
        const parts = token.split(".");
        const payloadPart = parts[1];
        if (parts.length !== 3 || !payloadPart) return undefined;
        const rawPayload: unknown = JSON.parse(
            Buffer.from(payloadPart, "base64url").toString("utf8"),
        );
        const payload = JwtPayloadSchema.decode(rawPayload);
        const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id?.trim();
        return accountId && accountId.length > 0 ? accountId : undefined;
    } catch {
        return undefined;
    }
}

async function resolveCodexProviderForModel(
    ctx: ExtensionContext,
    model: RuntimeModel,
    options: { readonly tokenUnavailableMessage: string; readonly requireAccountId?: boolean },
): Promise<CodexResult<CodexToolProvider>> {
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

    const authorization = headerValue(auth.headers, "Authorization");
    const bearerToken = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1]?.trim();
    const token = auth.apiKey ?? bearerToken;
    if (!token && !hasCredentialHeader(auth.headers)) {
        return fail(
            new CodexAuthUnavailable({
                operation: "codexAuth",
                message: options.tokenUnavailableMessage,
            }),
        );
    }

    const accountId =
        headerValue(auth.headers, "chatgpt-account-id") ??
        (token ? extractAccountId(token) : undefined);
    if (options.requireAccountId && !accountId) {
        return fail(
            new CodexAuthUnavailable({
                operation: "codexAuth",
                message: "OpenAI Codex account id is unavailable.",
            }),
        );
    }

    const redactedHeaders = redactProviderHeaders(auth.headers);
    const baseUrl = resolveCodexApiProviderBaseUrl(model.baseUrl);
    const provider: CodexToolProviderConstruction = token
        ? { baseUrl, model: model.id, token: Redacted.of(token), accountId: accountId ?? "" }
        : { baseUrl, model: model.id, accountId: accountId ?? "" };
    if (Object.keys(redactedHeaders).length > 0) provider.redactedHeaders = redactedHeaders;
    return ok(provider);
}

function hasCredentialHeader(headers: ProviderHeaders | undefined): boolean {
    return [
        "authorization",
        "api-key",
        "x-api-key",
        "x-openai-api-key",
        "cf-aig-authorization",
    ].some((name) => headerValue(headers, name) !== undefined);
}

function resolveCodexToolAuthModel(ctx: ExtensionContext): CodexResult<RuntimeModel> {
    if (isUsableOpenAICodexModel(ctx.model)) return ok(ctx.model);

    const currentId = ctx.model?.id;
    const direct = currentId ? ctx.modelRegistry.find(OPENAI_CODEX_PROVIDER, currentId) : undefined;
    if (isUsableOpenAICodexModel(direct)) return ok(direct);

    for (const modelId of [...CODEX_TEXT_MODEL_CHOICES, "gpt-5.3-codex-spark"]) {
        const model = ctx.modelRegistry.find(OPENAI_CODEX_PROVIDER, modelId);
        if (isUsableOpenAICodexModel(model)) return ok(model);
    }

    const availableModel = ctx.modelRegistry.getAvailable().find(isUsableOpenAICodexModel);
    if (availableModel) return ok(availableModel);

    const registeredModel = ctx.modelRegistry.getAll().find(isUsableOpenAICodexModel);
    if (registeredModel) return ok(registeredModel);

    return fail(
        new CodexUnsupportedModel({
            operation: "codexAuth",
            message:
                "Codex tools require /login openai-codex or an available OpenAI Codex Responses model.",
        }),
    );
}

function isUsableOpenAICodexModel(
    model: ExtensionContext["model"] | undefined,
): model is RuntimeModel {
    return (
        isModelWithStringApi(model) &&
        model.provider.trim().toLowerCase() === OPENAI_CODEX_PROVIDER &&
        model.api.includes("responses")
    );
}

/** Refine Pi's upstream `Model<any>` boundary to a model with a checked string API. */
export function isModelWithStringApi(
    model: ExtensionContext["model"] | undefined,
): model is RuntimeModel {
    return model !== undefined && StringDecoder.decode(model.api) !== undefined;
}

function redactProviderHeaders(
    headers: ProviderHeaders | undefined,
): NonNullable<CodexToolProvider["redactedHeaders"]> {
    const redactedHeaders: Record<string, Redacted<string>> = {};
    for (const [name, value] of Object.entries(headers ?? {})) {
        if (value === null) continue;
        redactedHeaders[name] = Redacted.of(value);
    }
    return redactedHeaders;
}

function headerValue(headers: ProviderHeaders | undefined, name: string): string | undefined {
    if (!headers) return undefined;
    const lowerName = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === lowerName && value !== null && value.trim().length > 0)
            return value;
    }
    return undefined;
}
