import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionSettings } from "./settings.ts";

const MAX_CONVERSATION_CONTEXT_CHARACTERS = 30_000;
const MAX_REPOSITORY_CONTEXT_CHARACTERS = 12_000;
const NAMING_STATE_VERSION = 1;

export const AUTONAME_STATE_ENTRY_TYPE = "pi-autoname-session.state";

/**
 * How much conversation content is rendered for the picker model.
 *
 * Minimized sends user messages, assistant text, tool names, and compaction
 * or branch summaries; full also sends tool arguments, tool results, and
 * shell output.
 */
export type ConversationScope = "minimized" | "full";

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
        version: Type.Literal(NAMING_STATE_VERSION),
        initialNameSet: Type.Boolean(),
        baseline: sessionMetricsSchema,
        baselineAtMs: Type.Number({ minimum: 0 }),
    },
    { additionalProperties: false },
);

const legacySessionNamingStateSchema = Type.Object(
    {
        initialNameSet: Type.Boolean(),
        baseline: sessionMetricsSchema,
        baselineAtMs: Type.Number({ minimum: 0 }),
    },
    { additionalProperties: false },
);

const storedSessionNamingStateCandidateSchema = Type.Union([
    sessionNamingStateSchema,
    legacySessionNamingStateSchema,
    Type.Object({ version: Type.Number() }),
]);
const storedSessionNamingStateParser = {
    parse: (Value.Parse<typeof storedSessionNamingStateCandidateSchema>).bind(
        undefined,
        storedSessionNamingStateCandidateSchema,
    ),
};
const bigintSchema = Type.BigInt();
const primitiveValueSchema = Type.Union([
    Type.Null(),
    Type.Boolean(),
    Type.Number(),
    Type.String(),
]);
const referenceValueSchema = Type.Union([
    Type.Array(Type.Unknown()),
    Type.Object({}, { additionalProperties: true }),
]);

export type SessionMetrics = {
    readonly messages: number;
    readonly turns: number;
    readonly toolCalls: number;
    readonly tokens: number;
};

export type SessionNamingState = {
    readonly version: 1;
    readonly initialNameSet: boolean;
    readonly baseline: SessionMetrics;
    readonly baselineAtMs: number;
};

export type StoredSessionNamingStateResult =
    | { readonly type: "found"; readonly state: SessionNamingState }
    | { readonly type: "invalid" }
    | { readonly type: "unsupportedVersion" };
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

/** Input for creating a naming state from already trusted, measured pieces. */
export type SessionNamingStateInput = {
    readonly initialNameSet: boolean;
    readonly baseline: SessionMetrics;
    readonly baselineAtMs: number;
};

/** Create a naming state from already trusted, measured pieces. */
export function createSessionNamingState(input: SessionNamingStateInput): SessionNamingState {
    return {
        version: NAMING_STATE_VERSION,
        initialNameSet: input.initialNameSet,
        baseline: {
            messages: input.baseline.messages,
            turns: input.baseline.turns,
            toolCalls: input.baseline.toolCalls,
            tokens: input.baseline.tokens,
        },
        baselineAtMs: input.baselineAtMs,
    };
}

/** Classify and parse one persisted naming-state entry. */
export function parseStoredSessionNamingState(value: unknown): StoredSessionNamingStateResult {
    try {
        const candidate = storedSessionNamingStateParser.parse(value);
        if ("version" in candidate) {
            if (candidate.version !== NAMING_STATE_VERSION) {
                return { type: "unsupportedVersion" };
            }
            if (!Value.Check(sessionNamingStateSchema, candidate)) {
                return { type: "invalid" };
            }

            return {
                type: "found",
                state: createSessionNamingState({
                    initialNameSet: candidate.initialNameSet,
                    baseline: candidate.baseline,
                    baselineAtMs: candidate.baselineAtMs,
                }),
            };
        }

        return {
            type: "found",
            state: createSessionNamingState({
                initialNameSet: candidate.initialNameSet,
                baseline: candidate.baseline,
                baselineAtMs: candidate.baselineAtMs,
            }),
        };
    } catch {
        return { type: "invalid" };
    }
}

/**
 * Parse persisted naming state read from a session entry.
 *
 * Unversioned state written by releases before state versioning is migrated
 * to version 1. Invalid and unsupported future state return undefined.
 */
export function parseSessionNamingState(value: unknown): SessionNamingState | undefined {
    const result = parseStoredSessionNamingState(value);
    return result.type === "found" ? result.state : undefined;
}

/**
 * True when the activity between the baseline and now reaches the trigger
 * threshold (counts for message/turn/tool-call/token triggers, elapsed
 * minutes for the minutes trigger).
 */
export function hasReachedTrigger(
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

/**
 * Count session activity from branch entries: user messages, assistant turns,
 * assistant tool calls, and assistant token usage. Non-message entries are
 * ignored.
 */
export function measureSession(entries: readonly SessionEntry[]): SessionMetrics {
    const metrics = {
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
            case "assistant": {
                metrics.turns += 1;
                metrics.toolCalls += entry.message.content.filter(
                    (block) => block.type === "toolCall",
                ).length;
                const usage = entry.message.usage;
                // Session files are persisted boundary data: the framework
                // type requires usage on assistant messages, but a message
                // written by an older or third-party writer may lack it.
                // Missing usage contributes no tokens instead of NaN.
                if (usage !== undefined) {
                    metrics.tokens += usage.totalTokens;
                }
                break;
            }
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

/**
 * Decide whether a naming attempt is due for the given state and metrics.
 * Returns undefined when no trigger is reached.
 */
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

/** Mark the session as named, resetting the baseline to the current metrics. */
export function markSessionNamingComplete(
    metrics: SessionMetrics,
    nowMs: number,
): SessionNamingState {
    return createSessionNamingState({
        initialNameSet: true,
        baseline: metrics,
        baselineAtMs: nowMs,
    });
}

/**
 * Render the configured prompt with placeholders substituted in a single
 * pass, then append the name-constraint instructions. Inserted content is
 * never reprocessed for later placeholders.
 */
export function renderNamingPrompt(
    prompt: string,
    variables: PromptVariables,
    minLength: number,
    maxLength: number,
): string {
    const replacements = new Map([
        ["{{repository_context}}", variables.repositoryContext],
        ["{{conversation}}", variables.conversation],
        ["{{current_name}}", variables.currentName],
        ["{{cwd}}", variables.cwd],
        ["{{reason}}", variables.reason],
    ]);

    const rendered = prompt.replace(/\{\{\w+\}\}/g, (placeholder) => {
        return replacements.get(placeholder) ?? placeholder;
    });

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

function stringifyPromptValue(value: ToolCall["arguments"]): string {
    const seen = new WeakSet<object>();
    try {
        return (
            JSON.stringify(value, (_key, nestedValue) => {
                if (Value.Check(bigintSchema, nestedValue)) {
                    return nestedValue.toString();
                }
                if (
                    Object.is(nestedValue, Number.NaN) ||
                    nestedValue === Number.POSITIVE_INFINITY ||
                    nestedValue === Number.NEGATIVE_INFINITY
                ) {
                    return null;
                }
                if (Value.Check(referenceValueSchema, nestedValue)) {
                    if (seen.has(nestedValue)) {
                        return "[circular]";
                    }
                    seen.add(nestedValue);
                    return nestedValue;
                }
                if (Value.Check(primitiveValueSchema, nestedValue)) {
                    return nestedValue;
                }
                return undefined;
            }) ?? "[unserializable value]"
        );
    } catch {
        return "[unserializable value]";
    }
}

/**
 * Normalize picker output into a session name: take the first non-empty
 * line, strip Markdown heading markers and a leading "session name:" label,
 * remove surrounding quotes, collapse whitespace, and enforce length
 * constraints. Returns undefined when no usable name remains.
 */
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

/**
 * Build the repository context section: the working directory plus loaded
 * repository guidance files, truncated to MAX_REPOSITORY_CONTEXT_CHARACTERS.
 */
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
    scope: ConversationScope,
): string {
    if (Value.Check(Type.String(), content)) {
        return content.trim();
    }

    const parts: string[] = [];
    for (const block of content) {
        switch (block.type) {
            case "text":
                parts.push(block.text);
                break;
            case "toolCall":
                parts.push(
                    scope === "minimized"
                        ? `[tool call: ${block.name}]`
                        : `[tool call: ${block.name} ${stringifyPromptValue(block.arguments)}]`,
                );
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

function renderMessage(
    message: Extract<SessionEntry, { type: "message" }>["message"],
    scope: ConversationScope,
): string {
    switch (message.role) {
        case "bashExecution":
            return scope === "minimized" ? "" : `Ran: ${message.command}\n${message.output}`.trim();
        case "branchSummary":
        case "compactionSummary":
            return message.summary.trim();
        case "toolResult":
        case "custom":
            return scope === "minimized" ? "" : renderContent(message.content, scope);
        case "user":
        case "assistant":
            return renderContent(message.content, scope);
    }
}

/**
 * Render conversation entries for the picker model prompt, truncated to
 * MAX_CONVERSATION_CONTEXT_CHARACTERS. Pass the active, compaction-aware
 * entry list (SessionManager.buildContextEntries) so compacted-away history
 * is not resent.
 */
export function buildConversationContext(
    entries: readonly SessionEntry[],
    scope: ConversationScope,
    pendingPrompt?: string,
): string {
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

        const text = renderMessage(entry.message, scope);
        if (text.length > 0) {
            sections.push(`${entry.message.role}:\n${text}`);
        }
    }

    if (pendingPrompt !== undefined) {
        sections.push(`user:\n${pendingPrompt}`);
    }

    return truncatePromptContext(sections.join("\n\n"), MAX_CONVERSATION_CONTEXT_CHARACTERS);
}
