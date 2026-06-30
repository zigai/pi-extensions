import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
    withFileMutationQueue,
    type ExtensionAPI,
    type ExtensionContext,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { resolveCodexRequestModel, type CodexCoreConfig } from "../config.ts";
import { codexToolProviderHeaders, resolveCodexToolProvider } from "../codex-auth.ts";
import { resolveCodexCoreArtifactPath, sanitizeArtifactPathPart } from "../artifacts.ts";
import { formatWebRunToolOutput } from "./web-run-output.ts";

export const WEB_RUN_TOOL_NAME = "web_run";

const SearchQueryParameters = Type.Object({
    q: Type.String({ description: "Search query." }),
    recency: Type.Optional(Type.Number({ description: "Number of recent days to filter by." })),
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
        Type.Array(Type.Object({ ref_id: Type.String(), lineno: Type.Optional(Type.Number()) }), {
            description: "Open pages by ref id or URL.",
        }),
    ),
    click: Type.Optional(
        Type.Array(Type.Object({ ref_id: Type.String(), id: Type.Number() }), {
            description: "Open numbered links from previously opened pages.",
        }),
    ),
    find: Type.Optional(
        Type.Array(Type.Object({ ref_id: Type.String(), pattern: Type.String() }), {
            description: "Find text in an opened page.",
        }),
    ),
    screenshot: Type.Optional(
        Type.Array(Type.Object({ ref_id: Type.String(), pageno: Type.Number() }), {
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
                duration: Type.Optional(Type.Number()),
            }),
        ),
    ),
    sports: Type.Optional(
        Type.Array(
            Type.Object({
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
                num_games: Type.Optional(Type.Number()),
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
    settings: Type.Optional(
        Type.Object({
            search_context_size: Type.Optional(StringEnum(["low", "medium", "high"] as const)),
        }),
    ),
});

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
};

export function registerWebRunTool(pi: ExtensionAPI, options: WebRunOptions): void {
    pi.registerTool(createWebRunTool(options));
}

export function createWebRunTool(
    options: WebRunOptions,
): ToolDefinition<typeof WEB_RUN_PARAMETERS, WebRunDetails> {
    return {
        name: WEB_RUN_TOOL_NAME,
        label: "Web Search",
        description:
            "Access Codex web search: search, open, click, find, screenshots, finance, weather, sports, and time.",
        promptSnippet: "Search or open the web through Codex-backed web access.",
        promptGuidelines: [
            "Use web_run when the user asks for current, external, or source-backed information; cite sources from returned URLs in the final answer.",
            "Do not copy Codex hidden citation markers like `cite...` into final answers; cite ordinary URLs or source titles from web_run output instead.",
            "Use web_run open/click/find with returned ref ids instead of repeating broad searches when drilling into a result.",
        ],
        parameters: WEB_RUN_PARAMETERS,
        prepareArguments: (args) => (isRecord(args) ? args : {}),
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
            const output = firstTextContent(result.content);
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
            const response = await executeWebRun(params, ctx, options.getConfig(), signal);
            const output = await prepareWebRunOutput(response.output, toolCallId, ctx);
            return {
                content: [{ type: "text", text: output.text }],
                details: {
                    fullOutputPath: output.fullOutputPath,
                    outputCharacters: response.output.length,
                    sourceCount: output.sourceCount,
                },
            };
        },
    };
}

async function executeWebRun(
    params: Record<string, unknown>,
    ctx: ExtensionContext,
    config: CodexCoreConfig,
    signal: AbortSignal | undefined,
): Promise<{ readonly output: string }> {
    const provider = await resolveCodexToolProvider(ctx);
    const headers = codexToolProviderHeaders(provider);
    headers.set("accept", "application/json");
    const { settings, commands } = splitSearchRequest(params);
    const input = recentSearchContext(ctx);
    const model = resolveCodexRequestModel(config.openai.webSearchModel, provider.model);

    const response = await fetch(`${provider.baseUrl}/alpha/search`, {
        method: "POST",
        headers,
        ...(signal ? { signal } : {}),
        body: JSON.stringify({
            id: safeSessionId(ctx.sessionManager.getSessionId()),
            model,
            ...(input ? { input } : {}),
            commands,
            ...(settings ? { settings } : {}),
        }),
    });

    const responseText = await response.text();
    if (!response.ok)
        throw new Error(
            `web_run failed (${response.status}): ${responseText || response.statusText}`,
        );
    const parsed = JSON.parse(responseText) as unknown;
    const output = parseSearchOutput(parsed);
    if (!output) throw new Error("web_run returned no output");
    return { output };
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
    if (args.settings?.search_context_size)
        parts.push(`context=${args.settings.search_context_size}`);
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
        if (
            isRecord(item) &&
            item.type === "text" &&
            typeof item.text === "string" &&
            item.text.trim().length > 0
        ) {
            return item.text.trim();
        }
    }
    return undefined;
}

function splitSearchRequest(params: Record<string, unknown>): {
    readonly commands: Record<string, unknown>;
    readonly settings?: Record<string, unknown>;
} {
    const commands: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || key === "settings") continue;
        commands[key] = value;
    }
    const settings = isRecord(params.settings) ? stripUndefined(params.settings) : undefined;
    return settings && Object.keys(settings).length > 0 ? { commands, settings } : { commands };
}

async function prepareWebRunOutput(
    output: string,
    toolCallId: string,
    ctx: ExtensionContext,
): Promise<{
    readonly text: string;
    readonly fullOutputPath: string;
    readonly sourceCount: number;
}> {
    const fullOutputPath = await saveFullWebRunOutput(
        output,
        toolCallId,
        ctx.sessionManager.getSessionId(),
    );
    const formatted = formatWebRunToolOutput(output, fullOutputPath);
    return { text: formatted.text, fullOutputPath, sourceCount: formatted.sourceCount };
}

async function saveFullWebRunOutput(
    output: string,
    toolCallId: string,
    sessionId: string,
): Promise<string> {
    const absolutePath = resolveCodexCoreArtifactPath({
        category: "web-run",
        sessionId,
        fileName: `${sanitizeArtifactPathPart(toolCallId, "web_run")}.txt`,
    });
    await withFileMutationQueue(absolutePath, async () => {
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, output, "utf8");
    });
    return absolutePath;
}

function parseSearchOutput(value: unknown): string | undefined {
    if (!isRecord(value)) return undefined;
    if (typeof value.output === "string" && value.output.trim().length > 0) return value.output;
    if (typeof value.output_text === "string" && value.output_text.trim().length > 0)
        return value.output_text;
    if (typeof value.text === "string" && value.text.trim().length > 0) return value.text;
    return undefined;
}

function recentSearchContext(ctx: ExtensionContext): string | undefined {
    const lines: string[] = [];
    const branch = ctx.sessionManager.getBranch() as readonly unknown[];
    for (let index = branch.length - 1; index >= 0 && lines.length < 8; index -= 1) {
        const text = textFromMessageEntry(branch[index]);
        if (text) lines.push(text);
    }
    const context = lines.reverse().join("\n\n").slice(-4_000).trim();
    return context.length > 0 ? context : undefined;
}

function textFromMessageEntry(entry: unknown): string | undefined {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return undefined;
    const role = typeof entry.message.role === "string" ? entry.message.role : "message";
    if (role === "toolResult") return undefined;
    const text = textFromContent(entry.message.content);
    return text ? `[${role}] ${text}` : undefined;
}

function textFromContent(content: unknown): string | undefined {
    if (typeof content === "string") return content.trim() || undefined;
    if (!Array.isArray(content)) return undefined;
    const parts = content.flatMap((item) =>
        isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : [],
    );
    const text = parts.join("\n").trim();
    return text.length > 0 ? text : undefined;
}

function safeSessionId(id: string): string {
    return sanitizeArtifactPathPart(id, "web_run");
}

function stripUndefined(record: Record<string, unknown>): Record<string, unknown> {
    const stripped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
        if (value !== undefined) stripped[key] = value;
    }
    return stripped;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
