import { basename } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ExtensionSettings } from "./settings.ts";

const MAX_CONVERSATION_CONTEXT_CHARACTERS = 8_000;
const MAX_FIRST_USER_CONTEXT_CHARACTERS = 2_000;
const MAX_WORKSPACE_CONTEXT_CHARACTERS = 2_000;
const MAX_CHANGED_AREAS = 20;
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

    const marker = "\n...[context truncated]...\n";
    const contentCharacters = Math.max(0, maxCharacters - marker.length);
    if (contentCharacters === 0) {
        return marker.slice(0, maxCharacters);
    }

    const headLength = Math.floor(contentCharacters / 2);
    const tailLength = contentCharacters - headLength;
    return `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`;
}

function stringifyPromptValue(value: ToolCall["arguments"]): string {
    const seen = new WeakSet();

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

const OPAQUE_PROMPT_WORDS = new Set([
    "again",
    "ahead",
    "check",
    "changes",
    "commit",
    "continue",
    "current",
    "do",
    "finish",
    "fix",
    "go",
    "implement",
    "investigate",
    "it",
    "make",
    "please",
    "proceed",
    "review",
    "that",
    "this",
    "work",
]);

/** True when the visible request lacks a durable subject of its own. */
export function isOpaqueNamingPrompt(prompt: string): boolean {
    const normalized = prompt.trim().replace(/^`+|`+$/g, "");
    if (normalized.length === 0) {
        return false;
    }

    if (/^[/$][\w.-]+(?:\s|$)/u.test(normalized)) {
        return true;
    }

    const words = normalized.toLowerCase().match(/[\p{L}\p{N}_+-]+/gu) ?? [];

    return (
        words.length > 0 &&
        words.length <= 5 &&
        words.every((word) => OPAQUE_PROMPT_WORDS.has(word))
    );
}

function summarizeChangedPath(rawPath: string): string | undefined {
    const renameTarget = rawPath.split(" -> ").at(-1)?.trim();
    const path = renameTarget?.replace(/^"|"$/g, "");
    if (path === undefined || path.length === 0) {
        return undefined;
    }

    const segments = path.split("/").filter((segment) => segment.length > 0);
    if (segments.length >= 2 && ["apps", "crates", "packages"].includes(segments[0] ?? "")) {
        return `${segments[0]}/${segments[1]}`;
    }

    return path;
}

/**
 * Build compact workspace metadata. Git status is supplied only for opaque
 * first prompts; repository guidance contents are deliberately excluded.
 */
export function buildRepositoryContext(cwd: string, gitStatus?: string): string {
    const sections = [`Repository: ${basename(cwd)}`, `Working directory: ${cwd}`];
    if (gitStatus === undefined) {
        return sections.join("\n");
    }

    const changedAreas: string[] = [];
    let branch: string | undefined;
    for (const line of gitStatus.split(/\r?\n/u)) {
        if (line.startsWith("## ")) {
            branch = line.slice(3).split("...")[0]?.split(" [")[0]?.trim();
            continue;
        }

        if (line.length < 4) {
            continue;
        }

        const area = summarizeChangedPath(line.slice(3));
        if (area !== undefined && !changedAreas.includes(area)) {
            changedAreas.push(area);
        }
    }

    if (branch !== undefined && branch.length > 0) {
        sections.push(`Branch: ${branch}`);
    }

    if (changedAreas.length > 0) {
        const visibleAreas = changedAreas.slice(0, MAX_CHANGED_AREAS);
        const omitted = changedAreas.length - visibleAreas.length;
        const lines = visibleAreas.map((area) => `- ${area}`);
        if (omitted > 0) {
            lines.push(`- ...and ${omitted} more`);
        }

        sections.push(`Changed areas:\n${lines.join("\n")}`);
    }

    return truncatePromptContext(sections.join("\n"), MAX_WORKSPACE_CONTEXT_CHARACTERS);
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
                if (scope === "full") {
                    parts.push(
                        `[tool call: ${block.name} ${stringifyPromptValue(block.arguments)}]`,
                    );
                }
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

type ConversationSection = {
    readonly role: "USER" | "ASSISTANT" | "SUMMARY" | "TOOL";
    readonly text: string;
};

function collectConversationSections(
    entries: readonly SessionEntry[],
    scope: ConversationScope,
): ConversationSection[] {
    const sections: ConversationSection[] = [];
    for (const entry of entries) {
        if (entry.type === "compaction" || entry.type === "branch_summary") {
            sections.push({ role: "SUMMARY", text: entry.summary.trim() });
            continue;
        }

        if (entry.type !== "message") {
            continue;
        }

        const text = renderMessage(entry.message, scope);
        if (text.length === 0) {
            continue;
        }

        if (entry.message.role === "user") {
            sections.push({ role: "USER", text });
        } else if (entry.message.role === "assistant") {
            sections.push({ role: "ASSISTANT", text });
        } else {
            sections.push({ role: "TOOL", text });
        }
    }

    return sections;
}

function renderConversationSection(section: ConversationSection): string {
    return `${section.role}:\n${section.text}`;
}

function truncateInitialUserMessage(message: string): string {
    const prefix = "USER:\n";
    const available = MAX_CONVERSATION_CONTEXT_CHARACTERS - prefix.length;
    if (message.length <= available) {
        return `${prefix}${message}`;
    }

    return `${prefix}${message.slice(0, available - "\n[message truncated]".length)}\n[message truncated]`;
}

/**
 * Render focused title context. Initial naming receives only the first user
 * request. Refresh naming receives user and assistant text with the first
 * user request pinned and the recent tail retained inside an 8k budget.
 */
export function buildConversationContext(
    entries: readonly SessionEntry[],
    options: {
        readonly phase: NamingPhase;
        readonly scope: ConversationScope;
        readonly pendingPrompt?: string | undefined;
    },
): string {
    const sections = collectConversationSections(entries, options.scope);
    if (options.phase === "initial") {
        const firstUserMessage =
            options.pendingPrompt ??
            sections.find((section) => section.role === "USER")?.text ??
            "";

        return truncateInitialUserMessage(firstUserMessage);
    }

    const rendered = sections.map(renderConversationSection);
    const completeContext = rendered.join("\n\n");
    if (completeContext.length <= MAX_CONVERSATION_CONTEXT_CHARACTERS) {
        return completeContext;
    }

    const firstUserIndex = sections.findIndex((section) => section.role === "USER");
    const firstUser = firstUserIndex >= 0 ? sections[firstUserIndex] : undefined;
    const firstUserText = firstUser?.text ?? "";
    const pinnedText = firstUserText.slice(0, MAX_FIRST_USER_CONTEXT_CHARACTERS);
    const pinned = pinnedText.length > 0 ? `USER:\n${pinnedText}` : "";
    const marker = "[Earlier conversation truncated]";
    const separatorLength = pinned.length > 0 ? 4 : 2;
    let remaining =
        MAX_CONVERSATION_CONTEXT_CHARACTERS - pinned.length - marker.length - separatorLength;
    const recent: string[] = [];

    for (let index = rendered.length - 1; index >= 0 && remaining > 0; index -= 1) {
        if (index === firstUserIndex) {
            continue;
        }

        const section = rendered[index];
        if (section === undefined) {
            continue;
        }

        const separator = recent.length > 0 ? 2 : 0;
        const available = remaining - separator;
        if (available <= 0) {
            break;
        }

        if (section.length > available) {
            recent.unshift(section.slice(-available));
            remaining = 0;
            break;
        }

        recent.unshift(section);
        remaining -= section.length + separator;
    }

    return [pinned, marker, recent.join("\n\n")].filter((part) => part.length > 0).join("\n\n");
}
