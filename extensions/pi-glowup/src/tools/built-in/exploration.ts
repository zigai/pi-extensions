import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stringParser } from "../../json-scalar.ts";
import Type from "typebox";
import { Value } from "typebox/value";
import { isJsonArray, jsonValueParser, type JsonValue } from "../../json-value.ts";
import { canonicalBuiltInToolName } from "./names.ts";
import { emptyComponent } from "../../rendering/component.ts";
import { retireIdleSyntaxHighlightSource } from "../../rendering/syntax/highlighter.ts";
import {
    renderGlowupCall,
    renderGlowupExplore,
    type GlowupCallRenderOptions,
} from "../../rendering/tool-header.ts";
import { renderGlowupOutput, type GlowupOutputRenderOptions } from "../../rendering/output.ts";
import { type GlowupRenderTheme } from "../../rendering/theme.ts";
import { toolStatusLabel, type ToolLabelMode } from "../../rendering/status-labels.ts";
import { isRecord } from "../../unknown-values.ts";
import { textOutput, webSearchQuery } from "./arguments.ts";
import {
    callState,
    type BuiltInRenderContext,
    type BuiltInRenderTheme,
    type TextResult,
} from "./context.ts";
import {
    ExplorationGroupStore,
    type ExplorationRenderContext,
    type ExplorationSourcePosition,
} from "./exploration-groups.ts";

const assistantEntrySchema = Type.Object({
    type: Type.Literal("message"),
    message: Type.Object({ role: Type.Literal("assistant"), content: Type.Array(Type.Unknown()) }),
});

const toolCallSchema = Type.Object({
    type: Type.Literal("toolCall"),
    name: Type.Optional(Type.Unknown()),
    id: Type.Optional(Type.Unknown()),
});

export function createExplorationFeature() {
    type ExplorationSessionEntry = ReturnType<
        ExtensionContext["sessionManager"]["getBranch"]
    >[number];

    type ExplorationMessage = Extract<ExplorationSessionEntry, { type: "message" }>["message"];

    type SourceIndex = {
        readonly positions: Map<string, ExplorationSourcePosition>;
        length: number;
        last: ExplorationSessionEntry | undefined;
    };

    let explorationSourceEntries: (() => readonly ExplorationSessionEntry[]) | undefined;
    let streamingExplorationMessage: ExplorationMessage | undefined;
    let sourceIndex: SourceIndex = { positions: new Map(), length: 0, last: undefined };

    function toolCallIndex(message: ExplorationMessage | undefined, toolCallId: string): number {
        if (message?.role !== "assistant") return -1;

        return message.content.findIndex(
            (content) => content.type === "toolCall" && content.id === toolCallId,
        );
    }

    // Branch entries are append-only until the source is replaced on session start
    // or tree navigation, so indexed positions stay valid and only a miss rereads it.
    function refreshSourceIndex(): void {
        const entries = explorationSourceEntries?.() ?? [];
        let start = sourceIndex.length;
        if (start === 0 || entries.length < start || entries[start - 1] !== sourceIndex.last) {
            sourceIndex = { positions: new Map(), length: 0, last: undefined };
            start = 0;
        }

        for (let index = start; index < entries.length; index += 1) {
            const entry = entries[index];
            if (entry?.type !== "message" || entry.message.role !== "assistant") continue;

            // Persisted chronology prefers the latest entry and its first matching content.
            const content = entry.message.content;
            for (let contentIndex = content.length - 1; contentIndex >= 0; contentIndex -= 1) {
                const part = content[contentIndex];
                if (part?.type === "toolCall")
                    sourceIndex.positions.set(part.id, [index, contentIndex]);
            }
        }

        sourceIndex.length = entries.length;
        sourceIndex.last = entries.at(-1);
    }

    function explorationSourcePosition(toolCallId: string): ExplorationSourcePosition | undefined {
        // Persisted source takes precedence over the latest streaming snapshot.
        const indexed = sourceIndex.positions.get(toolCallId);
        if (indexed !== undefined) return indexed;

        refreshSourceIndex();

        const persisted = sourceIndex.positions.get(toolCallId);
        if (persisted !== undefined) return persisted;

        const streamingIndex = toolCallIndex(streamingExplorationMessage, toolCallId);
        if (streamingIndex === -1) return undefined;

        return [sourceIndex.length, streamingIndex];
    }

    const explorationGroups = new ExplorationGroupStore(undefined, explorationSourcePosition);

    function renderExplorationResult(
        result: TextResult,
        expanded: boolean,
        theme: GlowupRenderTheme,
        options?: {
            readonly syntaxPath: string | undefined;
            readonly invalidate?: (() => void) | undefined;
        },
    ) {
        // Hidden plain results need no source owner. Keep finished colors and
        // in-flight syntax work so re-expansion never flashes uncolored code.
        if (!expanded) {
            if (options?.invalidate !== undefined)
                retireIdleSyntaxHighlightSource(options.invalidate);

            return emptyComponent();
        }

        const output = textOutput(result);
        if (output === undefined) {
            return emptyComponent();
        }

        let renderOptions: GlowupOutputRenderOptions = {
            expanded,
            mode: "hidden",
            prefixFirst: "",
            prefixRest: "",
            noOutputLabel: null,
            invalidate: options?.invalidate,
        };
        if (options?.syntaxPath !== undefined) {
            renderOptions = { ...renderOptions, syntax: { path: options.syntaxPath } };
        }

        return renderGlowupOutput(theme, output, renderOptions);
    }

    function renderExplorationCall(
        theme: GlowupRenderTheme,
        context: ExplorationRenderContext,
        action: string,
        labelMode: ToolLabelMode,
    ) {
        const decision = explorationGroups.register(context, action);
        if (decision.kind === "child") {
            return emptyComponent();
        }

        return renderGlowupExplore(theme, decision.actions, {
            statusText: toolStatusLabel(
                labelMode,
                { isPartial: decision.active },
                { static: "Explore", active: "Exploring", completed: "Explored" },
            ),
            state: decision.active ? "running" : "muted",
        });
    }

    function restoreExplorationGroupStarts(entries: readonly unknown[]): void {
        for (const entry of entries) {
            if (!Value.Check(assistantEntrySchema, entry)) continue;

            let previousWasExploration = false;
            for (const content of entry.message.content) {
                if (!Value.Check(toolCallSchema, content)) continue;

                const toolName = stringParser.parse(content.name);
                const toolCallId = stringParser.parse(content.id);
                const exploration = toolName !== undefined && isExplorationToolName(toolName);
                if (exploration && !previousWasExploration && toolCallId !== undefined) {
                    explorationGroups.registerGroupStart(toolCallId);
                }

                previousWasExploration = exploration;
            }
        }
    }

    function setSource(source: () => readonly ExplorationSessionEntry[]): void {
        explorationSourceEntries = source;
        sourceIndex = { positions: new Map(), length: 0, last: undefined };
    }

    function setMessage(message: ExplorationMessage): void {
        streamingExplorationMessage = message;
    }

    function clear(): void {
        explorationGroups.clear();
        explorationSourceEntries = undefined;
        streamingExplorationMessage = undefined;
        sourceIndex = { positions: new Map(), length: 0, last: undefined };
    }

    return {
        explorationGroups,
        renderExplorationResult,
        renderExplorationCall,
        restoreExplorationGroupStarts,
        setSource,
        setMessage,
        clear,
    };
}

export function syntaxPathFromToolArg(path: string | undefined): string | undefined {
    return path === undefined || path.length === 0 ? undefined : path;
}

export function isExplorationToolName(toolName: string): boolean {
    const builtInToolName = canonicalBuiltInToolName(toolName);
    return (
        builtInToolName === "read" ||
        builtInToolName === "find" ||
        builtInToolName === "grep" ||
        builtInToolName === "ls"
    );
}

export function hasVisibleAssistantText(message: unknown): boolean {
    const parsed = jsonValueParser.parse(message);
    if (!isRecord(parsed) || parsed.role !== "assistant" || !isJsonArray(parsed.content)) {
        return false;
    }

    return parsed.content.some(
        (content) =>
            isRecord(content) &&
            content.type === "text" &&
            stringParser.parse(content.text)?.trim().length !== 0,
    );
}

export function renderWebSearchCall(
    args: JsonValue | undefined,
    theme: BuiltInRenderTheme,
    context: BuiltInRenderContext,
    labelMode: ToolLabelMode,
) {
    const query = webSearchQuery(args);
    const active = context.isPartial || !context.argsComplete;
    let callOptions: GlowupCallRenderOptions = {
        state: callState(context),
        statusText: toolStatusLabel(labelMode, context, {
            static: "Web Search",
            active: "Searching the web",
            completed: "Searched the web",
        }),
    };
    if (query !== undefined) {
        callOptions = {
            ...callOptions,
            body: labelMode === "lifecycle" && !active ? `for ${query}` : query,
        };
    }

    return renderGlowupCall(theme, callOptions);
}
