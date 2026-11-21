import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
    compile,
    arr,
    int,
    lit,
    obj,
    oneOf,
    opt,
    str,
    type Static,
} from "@earendil-works/pi-schema";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import {
    withFileMutationQueue,
    type ExtensionAPI,
    type ExtensionContext,
    type SessionEntry,
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
import { compileSchema } from "../../schema-parsing.ts";
import { recentWebSearchInput } from "./history.ts";
import { parseWebRunSources } from "./output.ts";
import { parseGlowupWireArgs } from "../../glowup/wire.ts";
import {
    WEB_RUN_LABELS,
    webRunCallActions,
    webRunLabels,
    webRunReferenceRows,
    webRunResultLines,
    type WebRunPhase,
} from "./rendering.ts";
import { createWebRunGlowupRendering } from "./glowup-rendering.ts";
import { WebRunPageIndex } from "./pages.ts";

export const WEB_RUN_TOOL_NAME = "web_run";

const WEB_RUN_DESCRIPTION_PATH = fileURLToPath(
    new URL("./web-run-description.md", import.meta.url),
);
let cachedWebRunDescription: string | undefined;

const SearchQueryParameters = obj(
    {
        q: str({ description: "Search query." }),
        recency: opt(int({ minimum: 0, description: "Number of recent days to filter by." })),
        domains: opt(arr(str(), { description: "Domains to filter by." })),
    },
    { open: true },
);

const WEB_RUN_PARAMETERS = obj(
    {
        search_query: opt(arr(SearchQueryParameters, { description: "Internet search queries." })),
        image_query: opt(arr(SearchQueryParameters, { description: "Image search queries." })),
        open: opt(
            arr(
                obj(
                    {
                        ref_id: str(),
                        lineno: opt(int({ minimum: 0 })),
                    },
                    { open: true },
                ),
                { description: "Open pages by ref id or URL." },
            ),
        ),
        click: opt(
            arr(obj({ ref_id: str(), id: int({ minimum: 0 }) }, { open: true }), {
                description: "Open numbered links from previously opened pages.",
            }),
        ),
        find: opt(
            arr(obj({ ref_id: str(), pattern: str() }, { open: true }), {
                description: "Find text in an opened page.",
            }),
        ),
        screenshot: opt(
            arr(obj({ ref_id: str(), pageno: int({ minimum: 0 }) }, { open: true }), {
                description: "Take screenshots of PDF pages.",
            }),
        ),
        finance: opt(
            arr(
                obj(
                    {
                        ticker: str(),
                        type: oneOf(["equity", "fund", "crypto", "index"]),
                        market: opt(str()),
                    },
                    { open: true },
                ),
            ),
        ),
        weather: opt(
            arr(
                obj(
                    {
                        location: str(),
                        start: opt(str()),
                        duration: opt(int({ minimum: 0 })),
                    },
                    { open: true },
                ),
            ),
        ),
        sports: opt(
            arr(
                obj(
                    {
                        tool: opt({ type: "string", ...lit("sports") }),
                        fn: oneOf(["schedule", "standings"]),
                        league: oneOf([
                            "nba",
                            "wnba",
                            "nfl",
                            "nhl",
                            "mlb",
                            "epl",
                            "ncaamb",
                            "ncaawb",
                            "ipl",
                        ]),
                        team: opt(str()),
                        opponent: opt(str()),
                        date_from: opt(str()),
                        date_to: opt(str()),
                        num_games: opt(int({ minimum: 0 })),
                        locale: opt(str()),
                    },
                    { open: true },
                ),
            ),
        ),
        time: opt(arr(obj({ utc_offset: str() }, { open: true }))),
        response_length: opt(
            oneOf(["short", "medium", "long"], {
                description: "Length of returned response.",
            }),
        ),
    },
    { open: true },
);

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

const WebRunParametersValidator = compile(WEB_RUN_PARAMETERS);
const TextContentBlockSchema = compileSchema(
    Type.Object({ type: Type.Literal("text"), text: Type.String() }),
);
const WebRunResultMessageSchema = compileSchema(
    Type.Object({
        role: Type.Literal("toolResult"),
        toolName: Type.Literal(WEB_RUN_TOOL_NAME),
        content: Type.Array(Type.Unknown()),
    }),
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
type WebRunCommandKey = (typeof WEB_RUN_COMMAND_KEYS)[number];

type WebRunCommands = {
    [Key in WebRunCommandKey]?: WebRunParams[Key];
} & {
    response_length?: WebRunParams["response_length"];
};

type WebRunDetails = {
    readonly fullOutputPath: string;
    readonly outputCharacters: number;
    readonly sourceCount: number;
};

type WebRunOptions = {
    readonly getConfig: () => CodexCoreConfig;
    readonly runtime?: CodexRuntime | undefined;
    readonly tokenizer?: CodexTokenizer | undefined;
    readonly agentDir?: string | undefined;
    readonly pages?: WebRunPageIndex | undefined;
};

export function registerWebRunTool(pi: ExtensionAPI, options: WebRunOptions): void {
    pi.registerTool(createWebRunTool(options));
}

/** Text of every web_run result in the session, including other branches and compacted history. */
export function webRunSessionOutputs(entries: readonly SessionEntry[]): string[] {
    return entries.flatMap((entry) => {
        if (entry.type !== "message") return [];

        const message = WebRunResultMessageSchema.decode(entry.message);
        if (message === undefined) return [];

        return [
            message.content
                .flatMap((item) => {
                    const block = TextContentBlockSchema.decode(item);
                    return block === undefined ? [] : [block.text];
                })
                .join("\n"),
        ];
    });
}

export function createWebRunTool(options: WebRunOptions): ToolDefinition<
    typeof WEB_RUN_PARAMETERS,
    WebRunDetails
> & {
    readonly glowupRendering: ReturnType<typeof createWebRunGlowupRendering>;
} {
    const pages = options.pages ?? new WebRunPageIndex();
    const pageUrl = (refId: string) => pages.url(refId);

    return {
        name: WEB_RUN_TOOL_NAME,
        label: "Web Search",
        description: readWebRunDescription(),
        promptSnippet: "Search or open the web through Codex-backed web access.",
        promptGuidelines: [
            "Use web_run when the user asks for current, external, or source-backed information; cite sources from returned URLs in the final answer.",
            "Use web_run open/click/find with returned ref ids instead of repeating broad searches when drilling into a result.",
        ],
        glowupRendering: createWebRunGlowupRendering(pageUrl),
        parameters: WEB_RUN_PARAMETERS,
        prepareArguments: prepareWebRunArguments,
        renderCall(args, theme, context) {
            const phase: WebRunPhase = !context.isPartial
                ? "complete"
                : context.executionStarted
                  ? "running"
                  : "pending";
            const resultSucceeded = !context.isPartial && !context.isError;
            const actions = webRunCallActions(
                parseGlowupWireArgs(args) ?? {},
                resultSucceeded,
                pageUrl,
            );
            if (actions.length === 0 && resultSucceeded) return new Text("", 0, 0);

            const lines =
                actions.length === 0
                    ? [
                          theme.fg(
                              "toolTitle",
                              theme.bold(
                                  webRunLabels(WEB_RUN_LABELS, phase, context.isError).static,
                              ),
                          ),
                      ]
                    : actions.map(
                          (action) =>
                              theme.fg(
                                  "toolTitle",
                                  theme.bold(
                                      webRunLabels(action.labels, phase, context.isError).static,
                                  ),
                              ) +
                              " " +
                              theme.fg(action.isUrl ? "mdLinkUrl" : "accent", action.target),
                      );

            return new Text(lines.join("\n"), 0, 0);
        },
        renderResult(result, { expanded }, theme, context) {
            const rawOutput = result.content
                .flatMap((item) => {
                    const block = TextContentBlockSchema.decode(item);
                    return block === undefined ? [] : [block.text];
                })
                .join("\n");
            if (context.isError)
                return new Text(theme.fg("error", rawOutput || "Web request failed."), 0, 0);

            const references = webRunReferenceRows(
                parseGlowupWireArgs(context.args) ?? {},
                rawOutput,
                pageUrl,
            ).map(
                (row) =>
                    theme.fg(
                        row.error === undefined ? "toolTitle" : "error",
                        theme.bold(row.label),
                    ) +
                    " " +
                    theme.fg(row.isUrl ? "mdLinkUrl" : "accent", row.target) +
                    (row.error === undefined ? "" : theme.fg("muted", ` (${row.error})`)),
            );
            if (!expanded) return new Text(references.join("\n"), 0, 0);

            const lines = webRunResultLines(rawOutput).map((line) => {
                if (line.kind === "title") return theme.bold(theme.fg("toolOutput", line.text));
                if (line.kind === "url") return theme.fg("mdLinkUrl", line.text);
                if (line.kind === "omission") return theme.fg("muted", line.text);
                return theme.fg("toolOutput", line.text);
            });

            return new Text([...references, ...lines].join("\n"), 0, 0);
        },
        async execute(toolCallId, input, signal, _onUpdate, ctx) {
            const parsed = WebRunParametersValidator.validate(input);
            if (!parsed.ok) throw new Error("Invalid web_run arguments.");

            const tokenizer = options.tokenizer ?? new CodexTokenizer();

            try {
                const response = await executeWebRun(
                    parsed.value,
                    ctx,
                    options.getConfig(),
                    signal,
                    options.runtime ?? defaultCodexRuntime,
                    tokenizer,
                );
                if (response.isErr()) throw codexFailureToError(response.error);

                pages.record(response.value.output);

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

const prepareWebRunArguments = ((args): WebRunParams => {
    const parsed = WebRunParametersValidator.validate(args);
    if (!parsed.ok) throw new Error("Invalid web_run arguments.");

    splitSearchRequest(parsed.value);

    return parsed.value;
}) satisfies NonNullable<ToolDefinition["prepareArguments"]>;

async function executeWebRun(
    params: WebRunParams,
    ctx: ExtensionContext,
    config: CodexCoreConfig,
    signal: AbortSignal | undefined,
    runtime: CodexRuntime,
    tokenizer: CodexTokenizer,
): Promise<CodexResult<{ readonly output: string }>> {
    const provider = await resolveCodexToolProvider(ctx);
    if (provider.isErr()) return fail(provider.error);

    const headers = codexToolProviderHeaders(provider.value);
    headers.set("accept", "application/json");

    const commands = splitSearchRequest(params);
    const input = await recentWebSearchInput(ctx, tokenizer, { signal });
    const model = resolveCodexRequestModel(config.openai.webSearchModel, provider.value.model);
    const id = ctx.sessionManager.getSessionId();
    const settings = {
        allowed_callers: ["direct"],
        external_web_access: externalWebAccess(config.tools.webSearchMode),
    };
    const requestBody = JSON.stringify(
        input
            ? { id, model, input, commands, settings, max_output_tokens: WEB_RUN_MAX_OUTPUT_TOKENS }
            : { id, model, commands, settings, max_output_tokens: WEB_RUN_MAX_OUTPUT_TOKENS },
    );
    const fetched = await fetchWebRunWithRetries(
        `${provider.value.baseUrl}/alpha/search`,
        headers,
        requestBody,
        signal,
        runtime,
    );
    if (fetched.isErr()) return fail(fetched.error);

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
            const requestInit: RequestInit = signal
                ? { method: "POST", headers, signal, body }
                : { method: "POST", headers, body };

            response = await runtime.fetch(url, requestInit);
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

    return new Promise<boolean>((resolve) => {
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

function setWebRunCommand<Key extends WebRunCommandKey>(
    commands: WebRunCommands,
    key: Key,
    value: WebRunParams[Key],
): void {
    commands[key] = value;
}

function splitSearchRequest(params: WebRunParams): WebRunCommands {
    if (!hasRealWebRunCommand(params)) {
        throw new Error("web_run requires at least one non-empty command.");
    }

    const commands: WebRunCommands = {};
    for (const key of WEB_RUN_COMMAND_KEYS) {
        const value = params[key];
        if (value === undefined) continue;
        if (Array.isArray(value) && value.length === 0) continue;
        setWebRunCommand(commands, key, value);
    }

    if (params.response_length) commands.response_length = params.response_length;

    return commands;
}

function hasRealWebRunCommand(params: WebRunParams): boolean {
    return WEB_RUN_COMMAND_KEYS.some((key) => {
        const value: unknown = params[key];
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
    const sourceCount = parseWebRunSources(output).filter(
        (source) => source.url !== undefined,
    ).length;
    return { fullOutputPath, sourceCount };
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
    const output = SearchOutputSchema.decode(value);
    return output?.output;
}
