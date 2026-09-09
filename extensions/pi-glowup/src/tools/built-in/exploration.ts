import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stringParser } from "../../json-scalar.ts";
import Type from "typebox";
import { Value } from "typebox/value";
import { isJsonArray, jsonValueParser, type JsonValue } from "../../json-value.ts";
import { canonicalBuiltInToolName } from "./names.ts";
import { emptyComponent } from "../../rendering/component.ts";
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

    let explorationSourceEntries: (() => readonly ExplorationSessionEntry[]) | undefined;
    let streamingExplorationMessage: ExplorationMessage | undefined;

    function explorationSourcePosition(toolCallId: string): ExplorationSourcePosition | undefined {
        const entries = explorationSourceEntries?.() ?? [];
        const contentIndex = (message: ExplorationMessage | undefined): number => {
            if (message?.role !== "assistant") return -1;

            return message.content.findIndex(
                (content) => content.type === "toolCall" && content.id === toolCallId,
            );
        };

        // Borrow the host-owned branch rather than building an unbounded ID index.
        // Persisted source takes precedence over the latest streaming snapshot.
        for (let index = entries.length - 1; index >= 0; index -= 1) {
            const entry = entries[index];
            if (entry?.type !== "message") continue;

            const found = contentIndex(entry.message);
            if (found !== -1) return [index, found];
        }

        const streamingIndex = contentIndex(streamingExplorationMessage);
        return streamingIndex === -1 ? undefined : [entries.length, streamingIndex];
    }

    const explorationGroups = new ExplorationGroupStore(undefined, explorationSourcePosition);

    function renderExplorationResult(
        result: TextResult,
        expanded: boolean,
        theme: GlowupRenderTheme,
        options?: { readonly syntaxPath: string | undefined },
    ) {
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
    }

    function setMessage(message: ExplorationMessage): void {
        streamingExplorationMessage = message;
    }

    function clear(): void {
        explorationGroups.clear();
        explorationSourceEntries = undefined;
        streamingExplorationMessage = undefined;
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
