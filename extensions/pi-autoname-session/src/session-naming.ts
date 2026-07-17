import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionSettings } from "./settings.ts";

const MAX_CONVERSATION_CONTEXT_CHARACTERS = 30_000;
const MAX_REPOSITORY_CONTEXT_CHARACTERS = 12_000;

export const AUTONAME_STATE_ENTRY_TYPE = "pi-autoname-session.state";

const sessionMetricsSchema = Type.Object(
    {
        messages: Type.Number({ minimum: 0 }),
        turns: Type.Number({ minimum: 0 }),
        toolCalls: Type.Number({ minimum: 0 }),
        tokens: Type.Number({ minimum: 0 }),
    },
    { additionalProperties: false },
);

const sessionNamingStateSchema = Type.Object(
    {
        initialNameSet: Type.Boolean(),
        baseline: sessionMetricsSchema,
        baselineAtMs: Type.Number({ minimum: 0 }),
    },
    { additionalProperties: false },
);

export type SessionMetrics = Static<typeof sessionMetricsSchema>;
export type SessionNamingState = Static<typeof sessionNamingStateSchema>;
export type NamingTrigger = ExtensionSettings["initialNaming"]["trigger"];
export type NamingPhase = "initial" | "refresh";

export type NamingRequest = {
    readonly phase: NamingPhase;
    readonly trigger: NamingTrigger;
};

export type PromptVariables = {
    readonly repositoryContext: string;
    readonly conversation: string;
    readonly currentName: string;
    readonly cwd: string;
    readonly reason: NamingPhase;
};

export function parseSessionNamingState(value: unknown): SessionNamingState | undefined {
    if (!Value.Check(sessionNamingStateSchema, value)) {
        return undefined;
    }

    return Value.Decode(sessionNamingStateSchema, value);
}

export function createSessionNamingState(
    initialNameSet: boolean,
    baseline: SessionMetrics,
    baselineAtMs: number,
): SessionNamingState {
    return {
        initialNameSet,
        baseline,
        baselineAtMs,
    };
}

function hasReachedTrigger(
    trigger: NamingTrigger,
    threshold: number,
    currentMetrics: SessionMetrics,
    baseline: SessionMetrics,
    baselineAtMs: number,
    nowMs: number,
): boolean {
    if (trigger === "minutes") {
        return Math.max(0, nowMs - baselineAtMs) / 60_000 >= threshold;
    }

    const currentValue = currentMetrics[trigger === "tool_calls" ? "toolCalls" : trigger];
    const baselineValue = baseline[trigger === "tool_calls" ? "toolCalls" : trigger];
    return currentValue - baselineValue >= threshold;
}

export function measureSession(entries: readonly SessionEntry[]): SessionMetrics {
    const metrics: SessionMetrics = {
        messages: 0,
        turns: 0,
        toolCalls: 0,
        tokens: 0,
    };

    for (const entry of entries) {
        if (entry.type !== "message") {
            continue;
        }

        switch (entry.message.role) {
            case "user":
                metrics.messages += 1;
                break;
            case "assistant":
                metrics.turns += 1;
                metrics.tokens += entry.message.usage.totalTokens;
                metrics.toolCalls += entry.message.content.filter(
                    (block) => block.type === "toolCall",
                ).length;
                break;
            case "toolResult":
            case "bashExecution":
            case "branchSummary":
            case "compactionSummary":
            case "custom":
                break;
        }
    }

    return metrics;
}

export function getNamingRequest(
    settings: ExtensionSettings,
    state: SessionNamingState,
    currentMetrics: SessionMetrics,
    nowMs: number,
): NamingRequest | undefined {
    if (settings.initialNaming.enabled && !state.initialNameSet) {
        if (
            hasReachedTrigger(
                settings.initialNaming.trigger,
                settings.initialNaming.threshold,
                currentMetrics,
                state.baseline,
                state.baselineAtMs,
                nowMs,
            )
        ) {
            return { phase: "initial", trigger: settings.initialNaming.trigger };
        }
    }

    if (settings.refreshNaming.enabled && state.initialNameSet) {
        if (
            hasReachedTrigger(
                settings.refreshNaming.trigger,
                settings.refreshNaming.threshold,
                currentMetrics,
                state.baseline,
                state.baselineAtMs,
                nowMs,
            )
        ) {
            return { phase: "refresh", trigger: settings.refreshNaming.trigger };
        }
    }

    return undefined;
}

export function markSessionNamingComplete(
    metrics: SessionMetrics,
    nowMs: number,
): SessionNamingState {
    return createSessionNamingState(true, metrics, nowMs);
}

export function renderNamingPrompt(
    prompt: string,
    variables: PromptVariables,
    minLength: number,
    maxLength: number,
): string {
    const replacements: Record<string, string> = {
        "{{repository_context}}": variables.repositoryContext,
        "{{conversation}}": variables.conversation,
        "{{current_name}}": variables.currentName,
        "{{cwd}}": variables.cwd,
        "{{reason}}": variables.reason,
    };

    let rendered = prompt;
    for (const [placeholder, value] of Object.entries(replacements)) {
        rendered = rendered.replaceAll(placeholder, value);
    }

    return [
        rendered,
        "",
        `Return one name between ${minLength} and ${maxLength} characters.`,
        "Return only that name, without quotes, Markdown, or explanation.",
    ].join("\n");
}

function truncatePromptContext(text: string, maxCharacters: number): string {
    if (text.length <= maxCharacters) {
        return text;
    }

    const headLength = Math.floor(maxCharacters / 2);
    const tailLength = maxCharacters - headLength;
    return `${text.slice(0, headLength)}\n...[context truncated]...\n${text.slice(-tailLength)}`;
}

export function normalizeSessionName(
    rawName: string,
    minLength: number,
    maxLength: number,
): string | undefined {
    const firstLine = rawName
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);

    if (firstLine === undefined) {
        return undefined;
    }

    let name = firstLine.replace(/^#+\s*/, "").replace(/^session\s+name\s*:\s*/i, "");
    name = name.replace(/\s+/g, " ").trim();

    if (name.length >= 2) {
        const firstCharacter = name[0];
        const lastCharacter = name[name.length - 1];
        if (
            (firstCharacter === '"' && lastCharacter === '"') ||
            (firstCharacter === "'" && lastCharacter === "'") ||
            (firstCharacter === "`" && lastCharacter === "`")
        ) {
            name = name.slice(1, -1).trim();
        }
    }

    if (name.length > maxLength) {
        name = name.slice(0, maxLength).trimEnd();
    }

    return name.length >= minLength ? name : undefined;
}

export function buildRepositoryContext(
    cwd: string,
    contextFiles: readonly { readonly path: string; readonly content: string }[] | undefined,
): string {
    const sections = [`Working directory: ${cwd}`];

    for (const file of contextFiles ?? []) {
        sections.push(`Loaded repository guidance (${file.path}):\n${file.content}`);
    }

    return truncatePromptContext(sections.join("\n\n"), MAX_REPOSITORY_CONTEXT_CHARACTERS);
}

function renderContent(
    content: string | readonly (TextContent | ImageContent | ThinkingContent | ToolCall)[],
): string {
    if (typeof content === "string") {
        return content.trim();
    }

    const parts: string[] = [];
    for (const block of content) {
        switch (block.type) {
            case "text":
                parts.push(block.text);
                break;
            case "toolCall":
                parts.push(`[tool call: ${block.name} ${JSON.stringify(block.arguments)}]`);
                break;
            case "image":
                parts.push("[image attached]");
                break;
            case "thinking":
                break;
        }
    }

    return parts.join("\n").trim();
}

function renderMessage(message: Extract<SessionEntry, { type: "message" }>["message"]): string {
    switch (message.role) {
        case "bashExecution":
            return `Ran: ${message.command}\n${message.output}`.trim();
        case "branchSummary":
        case "compactionSummary":
            return message.summary.trim();
        case "custom":
        case "user":
        case "assistant":
        case "toolResult":
            return renderContent(message.content);
    }
}

export function buildConversationContext(entries: readonly SessionEntry[]): string {
    const sections: string[] = [];

    for (const entry of entries) {
        if (entry.type === "compaction") {
            sections.push(`Compaction summary:\n${entry.summary}`);
            continue;
        }

        if (entry.type === "branch_summary") {
            sections.push(`Branch summary:\n${entry.summary}`);
            continue;
        }

        if (entry.type !== "message") {
            continue;
        }

        const text = renderMessage(entry.message);
        if (text.length > 0) {
            sections.push(`${entry.message.role}:\n${text}`);
        }
    }

    return truncatePromptContext(sections.join("\n\n"), MAX_CONVERSATION_CONTEXT_CHARACTERS);
}
