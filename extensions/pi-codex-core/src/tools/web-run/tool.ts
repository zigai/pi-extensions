import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
    withFileMutationQueue,
    type ExtensionAPI,
    type ExtensionContext,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { resolveCodexRequestModel, type CodexCoreConfig } from "../../config/config.ts";
import { codexToolProviderHeaders, resolveCodexToolProvider } from "../../codex/auth.ts";
import { resolveCodexCoreArtifactPath, sanitizeArtifactPathPart } from "../../artifacts.ts";
import {
    CodexHttpRequestFailed,
    CodexInvalidJson,
    CodexNetworkUnavailable,
    CodexRequestCancelled,
    CodexUnexpectedResponse,
    codexFailureToError,
    fail,
    isAbortCause,
    ok,
    type CodexResult,
} from "../../codex/failures.ts";
import { defaultCodexRuntime, type CodexRuntime } from "../../runtime.ts";
import { CodexTokenizer } from "../../compaction/tokenizer.ts";
import { compileSchema, parseWithSchema } from "../../schema-parsing.ts";
import { recentWebSearchInput } from "./history.ts";
import { formatWebRunToolOutput } from "./output.ts";
import { webRunGlowupRendering } from "./glowup-rendering.ts";

export const WEB_RUN_TOOL_NAME = "web_run";

const WEB_RUN_DESCRIPTION_PATH = fileURLToPath(
    new URL("./web-run-description.md", import.meta.url),
);
let cachedWebRunDescription: string | undefined;

const SearchQueryParameters = Type.Object({
    q: Type.String({ description: "Search query." }),
    recency: Type.Optional(
        Type.Integer({ minimum: 0, description: "Number of recent days to filter by." }),
    ),
    domains: Type.Optional(Type.Array(Type.String(), { description: "Domains to filter by." })),
});

const WEB_RUN_PARAMETERS = Type.Object({
    search_query: Type.Optional(
        Type.Array(SearchQueryParameters, { description: "Internet search queries." }),
    ),
    image_query: Type.Optional(
        Type.Array(SearchQueryParameters, { description: "Image search queries." }),
    ),
    open: Type.Optional(
        Type.Array(
            Type.Object({
                ref_id: Type.String(),
                lineno: Type.Optional(Type.Integer({ minimum: 0 })),
            }),
            { description: "Open pages by ref id or URL." },
        ),
    ),
    click: Type.Optional(
        Type.Array(Type.Object({ ref_id: Type.String(), id: Type.Integer({ minimum: 0 }) }), {
            description: "Open numbered links from previously opened pages.",
        }),
    ),
    find: Type.Optional(
        Type.Array(Type.Object({ ref_id: Type.String(), pattern: Type.String() }), {
            description: "Find text in an opened page.",
        }),
    ),
    screenshot: Type.Optional(
        Type.Array(Type.Object({ ref_id: Type.String(), pageno: Type.Integer({ minimum: 0 }) }), {
            description: "Take screenshots of PDF pages.",
        }),
    ),
    finance: Type.Optional(
        Type.Array(
            Type.Object({
                ticker: Type.String(),
                type: StringEnum(["equity", "fund", "crypto", "index"] as const),
                market: Type.Optional(Type.String()),
            }),
        ),
    ),
    weather: Type.Optional(
        Type.Array(
            Type.Object({
                location: Type.String(),
                start: Type.Optional(Type.String()),
                duration: Type.Optional(Type.Integer({ minimum: 0 })),
            }),
        ),
    ),
    sports: Type.Optional(
        Type.Array(
            Type.Object({
                tool: Type.Optional(Type.Literal("sports")),
                fn: StringEnum(["schedule", "standings"] as const),
                league: StringEnum([
                    "nba",
                    "wnba",
                    "nfl",
                    "nhl",
                    "mlb",
                    "epl",
                    "ncaamb",
                    "ncaawb",
                    "ipl",
                ] as const),
                team: Type.Optional(Type.String()),
                opponent: Type.Optional(Type.String()),
                date_from: Type.Optional(Type.String()),
                date_to: Type.Optional(Type.String()),
                num_games: Type.Optional(Type.Integer({ minimum: 0 })),
                locale: Type.Optional(Type.String()),
            }),
        ),
    ),
    time: Type.Optional(Type.Array(Type.Object({ utc_offset: Type.String() }))),
    response_length: Type.Optional(
        StringEnum(["short", "medium", "long"] as const, {
            description: "Length of returned response.",
        }),
    ),
});

const WEB_RUN_COMMAND_KEYS = [
    "search_query",
    "image_query",
    "open",
    "click",
    "find",
    "screenshot",
    "finance",
    "weather",
    "sports",
    "time",
] as const;

const WebRunParametersValidator = compileSchema(WEB_RUN_PARAMETERS);
const TextContentBlockSchema = compileSchema(
    Type.Object({ type: Type.Literal("text"), text: Type.String() }),
);
const SearchOutputSchema = compileSchema(
    Type.Object({
        output: Type.String(),
        encrypted_output: Type.Optional(Type.String()),
    }),
);

const WEB_RUN_MAX_OUTPUT_TOKENS = 10_000;
const WEB_RUN_MAX_ATTEMPTS = 4;
const WEB_RUN_INITIAL_RETRY_DELAY_MS = 100;

type WebRunParams = Static<typeof WEB_RUN_PARAMETERS>;

type WebRunDetails = {
    readonly fullOutputPath: string;
    readonly outputCharacters: number;
    readonly sourceCount: number;
};

type WebRunSourceCard = {
    readonly title: string;
    readonly url?: string | undefined;
};

type WebRunOptions = {
    readonly getConfig: () => CodexCoreConfig;
    readonly runtime?: CodexRuntime | undefined;
    readonly tokenizer?: CodexTokenizer | undefined;
    readonly agentDir?: string | undefined;
};

export function registerWebRunTool(pi: ExtensionAPI, options: WebRunOptions): void {
    pi.registerTool(createWebRunTool(options));
}

export function createWebRunTool(options: WebRunOptions): ToolDefinition<
    typeof WEB_RUN_PARAMETERS,
    WebRunDetails
> & {
    readonly glowupRendering: typeof webRunGlowupRendering;
} {
    return {
        name: WEB_RUN_TOOL_NAME,
        label: "Web Search",
        description: readWebRunDescription(),
        promptSnippet: "Search or open the web through Codex-backed web access.",
        promptGuidelines: [
            "Use web_run when the user asks for current, external, or source-backed information; cite sources from returned URLs in the final answer.",
            "Use web_run open/click/find with returned ref ids instead of repeating broad searches when drilling into a result.",
        ],
        glowupRendering: webRunGlowupRendering,
        parameters: WEB_RUN_PARAMETERS,
        prepareArguments: prepareWebRunArguments,
        renderCall(args, theme, _context) {
            const summary = summarizeWebRunCall(args);
            const summaryColor = summary ? "accent" : "dim";
            const text =
                theme.fg("toolTitle", theme.bold("web_run ")) +
                theme.fg(summaryColor, summary ? summary : "...");
            return new Text(text, 0, 0);
        },
        renderResult(result, { expanded, isPartial }, theme, _context) {
            if (isPartial) return new Text(theme.fg("warning", "Searching web..."), 0, 0);
            const rawOutput = firstTextContent(result.content);
            const output = rawOutput
                ? formatWebRunToolOutput(rawOutput, result.details.fullOutputPath).text
                : undefined;
            if (expanded) return new Text(theme.fg("toolOutput", output ?? "No web output."), 0, 0);

            const cards = parseWebRunSourceCards(output);
            const sourceCount =
                result.details.sourceCount > 0 ? result.details.sourceCount : cards.length;
            const lines = [
                formatWebRunResultHeader(sourceCount, result.details.fullOutputPath, theme),
            ];
            for (const [index, card] of cards.slice(0, 2).entries()) {
                lines.push(theme.fg("dim", `${index + 1}. ${card.title}`));
                if (card.url) lines.push(theme.fg("muted", `   ${card.url}`));
            }
            const hiddenCount = Math.max(0, sourceCount - Math.min(cards.length, 2));
            const hint = "Ctrl+U to expand";
            if (hiddenCount > 0) lines.push(theme.fg("muted", `… ${hiddenCount} more (${hint})`));
            else if (output) lines.push(theme.fg("muted", `(${hint})`));
            return new Text(lines.join("\n"), 0, 0);
        },
        async execute(toolCallId, params, signal, _onUpdate, ctx) {
            const tokenizer = options.tokenizer ?? new CodexTokenizer();
            try {
                const response = await executeWebRun(
                    params,
                    ctx,
                    options.getConfig(),
                    signal,
                    options.runtime ?? defaultCodexRuntime,
                    tokenizer,
                );
                if (response.isErr()) throw codexFailureToError(response.error);
                const output = await prepareWebRunOutput(
                    response.value.output,
                    toolCallId,
                    ctx,
                    options.agentDir,
                    { signal },
                );
                return {
                    // Preserve Codex's response verbatim for follow-up open/click/find reference ids.
                    content: [{ type: "text", text: response.value.output }],
                    details: {
                        fullOutputPath: output.fullOutputPath,
                        outputCharacters: response.value.output.length,
                        sourceCount: output.sourceCount,
                    },
                };
            } finally {
                if (options.tokenizer === undefined) await tokenizer.shutdown();
            }
        },
    };
}

function readWebRunDescription(): string {
    cachedWebRunDescription ??= readFileSync(WEB_RUN_DESCRIPTION_PATH, "utf8")
        .trim()
        .replaceAll("`web.run`", "`web_run`");
    return cachedWebRunDescription;
}

function prepareWebRunArguments(args: unknown): WebRunParams {
    const params = parseWithSchema(WebRunParametersValidator, args);
    if (!params) throw new Error("Invalid web_run arguments.");
    splitSearchRequest(params);
    return params;
}

async function executeWebRun(
    params: WebRunParams,
    ctx: ExtensionContext,
    config: CodexCoreConfig,
    signal: AbortSignal | undefined,
    runtime: CodexRuntime,
    tokenizer: CodexTokenizer,
): Promise<CodexResult<{ readonly output: string }>> {
    const provider = await resolveCodexToolProvider(ctx);
    if (provider.isErr()) return provider;
    const headers = codexToolProviderHeaders(provider.value);
    headers.set("accept", "application/json");
    const commands = splitSearchRequest(params);
    const input = await recentWebSearchInput(ctx, tokenizer, { signal });
    const model = resolveCodexRequestModel(config.openai.webSearchModel, provider.value.model);

    const requestBody = JSON.stringify({
        id: ctx.sessionManager.getSessionId(),
        model,
        ...(input ? { input } : {}),
        commands,
        settings: {
            allowed_callers: ["direct"],
            external_web_access: externalWebAccess(config.tools.webSearchMode),
        },
        max_output_tokens: WEB_RUN_MAX_OUTPUT_TOKENS,
    });
    const fetched = await fetchWebRunWithRetries(
        `${provider.value.baseUrl}/alpha/search`,
        headers,
        requestBody,
        signal,
        runtime,
    );
    if (fetched.isErr()) return fetched;
    const { response, responseText } = fetched.value;
    if (!response.ok) {
        return fail(
            new CodexHttpRequestFailed({
                operation: "webRun",
                provider: "openai-codex",
                status: response.status,
                message: `web_run failed with HTTP ${response.status}.`,
            }),
        );
    }
    let rawSearchPayload: unknown;
    try {
        rawSearchPayload = JSON.parse(responseText);
    } catch (cause: unknown) {
        return fail(
            new CodexInvalidJson({
                operation: "webRun",
                provider: "openai-codex",
                message: "web_run response was not valid JSON.",
                cause,
            }),
        );
    }
    const output = parseSearchOutput(rawSearchPayload);
    if (output === undefined) {
        return fail(
            new CodexUnexpectedResponse({
                operation: "webRun",
                provider: "openai-codex",
                message: "web_run returned no output.",
            }),
        );
    }
    return ok({ output });
}

function externalWebAccess(mode: CodexCoreConfig["tools"]["webSearchMode"]): boolean | "indexed" {
    if (mode === "cached") return false;
    if (mode === "indexed") return "indexed";
    return true;
}

async function fetchWebRunWithRetries(
    url: string,
    headers: Headers,
    body: string,
    signal: AbortSignal | undefined,
    runtime: CodexRuntime,
): Promise<CodexResult<{ readonly response: Response; readonly responseText: string }>> {
    for (let attempt = 0; attempt < WEB_RUN_MAX_ATTEMPTS; attempt += 1) {
        let response: Response;
        try {
            response = await runtime.fetch(url, {
                method: "POST",
                headers,
                ...(signal ? { signal } : {}),
                body,
            });
        } catch (cause: unknown) {
            if (isAbortCause(cause) || signal?.aborted) return cancelledWebRun(cause);
            if (attempt + 1 < WEB_RUN_MAX_ATTEMPTS) {
                const waited = await waitBeforeRetry(attempt, signal);
                if (!waited) return cancelledWebRun(signal?.reason);
                continue;
            }
            return unavailableWebRun(cause);
        }

        let responseText: string;
        try {
            responseText = await response.text();
        } catch (cause: unknown) {
            if (isAbortCause(cause) || signal?.aborted) return cancelledWebRun(cause);
            if (attempt + 1 < WEB_RUN_MAX_ATTEMPTS) {
                const waited = await waitBeforeRetry(attempt, signal);
                if (!waited) return cancelledWebRun(signal?.reason);
                continue;
            }
            return unavailableWebRun(cause);
        }

        if (response.status >= 500 && attempt + 1 < WEB_RUN_MAX_ATTEMPTS) {
            const waited = await waitBeforeRetry(attempt, signal);
            if (!waited) return cancelledWebRun(signal?.reason);
            continue;
        }
        return ok({ response, responseText });
    }
    return unavailableWebRun(new Error("web_run retry limit exhausted."));
}

function cancelledWebRun(cause: unknown): CodexResult<never> {
    return fail(
        new CodexRequestCancelled({
            operation: "webRun",
            message: "web_run request was cancelled.",
            cause,
        }),
    );
}

function unavailableWebRun(cause: unknown): CodexResult<never> {
    return fail(
        new CodexNetworkUnavailable({
            operation: "webRun",
            provider: "openai-codex",
            message: "web_run network request failed.",
            cause,
        }),
    );
}

async function waitBeforeRetry(attempt: number, signal: AbortSignal | undefined): Promise<boolean> {
    if (signal?.aborted) return false;
    const delay = WEB_RUN_INITIAL_RETRY_DELAY_MS * 2 ** attempt;
    return await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve(true);
        }, delay);
        const onAbort = () => {
            clearTimeout(timeout);
            resolve(false);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function summarizeWebRunCall(args: WebRunParams): string {
    const parts: string[] = [];
    appendCountedValues(
        parts,
        "search",
        args.search_query?.map((query) => compactQuotedText(query.q)),
    );
    appendCountedValues(
        parts,
        "image",
        args.image_query?.map((query) => compactQuotedText(query.q)),
    );
    appendCountedValues(
        parts,
        "open",
        args.open?.map((request) =>
            request.lineno === undefined ? request.ref_id : `${request.ref_id}:L${request.lineno}`,
        ),
    );
    appendCountedValues(
        parts,
        "click",
        args.click?.map((request) => `${request.ref_id}#${request.id}`),
    );
    appendCountedValues(
        parts,
        "find",
        args.find?.map(
            (request) => `${compactQuotedText(request.pattern, 48)} in ${request.ref_id}`,
        ),
    );
    appendCountedValues(
        parts,
        "screenshot",
        args.screenshot?.map((request) => `${request.ref_id} p${request.pageno}`),
    );
    appendCountedValues(
        parts,
        "finance",
        args.finance?.map((request) => `${request.ticker}:${request.type}`),
    );
    appendCountedValues(
        parts,
        "weather",
        args.weather?.map((request) => request.location),
    );
    appendCountedValues(
        parts,
        "sports",
        args.sports?.map((request) => `${request.league} ${request.fn}`),
    );
    appendCountedValues(
        parts,
        "time",
        args.time?.map((request) => request.utc_offset),
    );
    if (args.response_length) parts.push(`length=${args.response_length}`);
    return parts.join(" • ");
}

function appendCountedValues(
    parts: string[],
    label: string,
    values: readonly string[] | undefined,
): void {
    if (!values || values.length === 0) return;
    const displayed = values.slice(0, 2).join(", ");
    const hiddenCount = values.length - 2;
    parts.push(hiddenCount > 0 ? `${label} ${displayed} +${hiddenCount}` : `${label} ${displayed}`);
}

function compactQuotedText(value: string, maxCharacters = 72): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    const limit = Math.max(4, maxCharacters);
    const text = normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
    return JSON.stringify(text);
}

function formatWebRunResultHeader(
    sourceCount: number,
    fullOutputPath: string,
    theme: { fg(color: "success" | "dim", text: string): string },
): string {
    const noun = sourceCount === 1 ? "source" : "sources";
    let text = theme.fg("success", `${sourceCount} ${noun}`);
    if (fullOutputPath) text += theme.fg("dim", ` • raw: ${fullOutputPath}`);
    return text;
}

function parseWebRunSourceCards(output: string | undefined): WebRunSourceCard[] {
    if (!output) return [];
    const cards: WebRunSourceCard[] = [];
    const lines = output.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
        const title = parseSourceTitle(lines[index]);
        if (!title) continue;
        cards.push({ title, url: findCardUrl(lines, index + 1) });
    }
    return cards;
}

function parseSourceTitle(line: string | undefined): string | undefined {
    const match = /^(\d+)\.\s+(.+)$/.exec(line ?? "");
    return match?.[2]?.trim();
}

function findCardUrl(lines: readonly string[], startIndex: number): string | undefined {
    for (let index = startIndex; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (/^\d+\.\s+/.test(line)) return undefined;
        const match = /^\s*URL:\s+(.+?)\s*$/.exec(line);
        if (match?.[1]) return match[1];
    }
    return undefined;
}

function firstTextContent(content: readonly unknown[]): string | undefined {
    for (const item of content) {
        const block = parseWithSchema(TextContentBlockSchema, item);
        if (block && block.text.trim().length > 0) return block.text.trim();
    }
    return undefined;
}

function splitSearchRequest(params: WebRunParams): Record<string, unknown> {
    if (!hasRealWebRunCommand(params)) {
        throw new Error("web_run requires at least one non-empty command.");
    }

    const commands: Record<string, unknown> = {};
    for (const key of WEB_RUN_COMMAND_KEYS) {
        const value = params[key];
        if (value === undefined) continue;
        if (Array.isArray(value) && value.length === 0) continue;
        commands[key] = value;
    }
    if (params.response_length) commands.response_length = params.response_length;
    return commands;
}

function hasRealWebRunCommand(params: WebRunParams): boolean {
    return WEB_RUN_COMMAND_KEYS.some((key) => {
        const value = params[key];
        return Array.isArray(value) ? value.length > 0 : value !== undefined;
    });
}

async function prepareWebRunOutput(
    output: string,
    toolCallId: string,
    ctx: ExtensionContext,
    agentDir: string | undefined,
    options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<{
    readonly fullOutputPath: string;
    readonly sourceCount: number;
}> {
    const fullOutputPath = await saveFullWebRunOutput(
        output,
        toolCallId,
        ctx.sessionManager.getSessionId(),
        agentDir,
        options,
    );
    const formatted = formatWebRunToolOutput(output, fullOutputPath);
    return { fullOutputPath, sourceCount: formatted.sourceCount };
}

async function saveFullWebRunOutput(
    output: string,
    toolCallId: string,
    sessionId: string,
    agentDir: string | undefined,
    options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<string> {
    options.signal?.throwIfAborted();
    const absolutePath = resolveCodexCoreArtifactPath({
        category: "web-run",
        sessionId,
        fileName: `${sanitizeArtifactPathPart(toolCallId, "web_run")}.txt`,
        agentDir,
    });
    await withFileMutationQueue(absolutePath, async () => {
        options.signal?.throwIfAborted();
        await mkdir(dirname(absolutePath), { recursive: true });
        options.signal?.throwIfAborted();
        await writeFile(absolutePath, output, { encoding: "utf8", signal: options.signal });
        options.signal?.throwIfAborted();
    });
    return absolutePath;
}

function parseSearchOutput(value: unknown): string | undefined {
    const output = parseWithSchema(SearchOutputSchema, value);
    return output?.output;
}
