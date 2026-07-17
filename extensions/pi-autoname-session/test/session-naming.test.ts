import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { ExtensionSettings } from "../src/settings.ts";
import {
    buildConversationContext,
    buildRepositoryContext,
    createSessionNamingState,
    getNamingRequest,
    measureSession,
    normalizeSessionName,
    parseSessionNamingState,
    renderNamingPrompt,
} from "../src/session-naming.ts";

const settings: ExtensionSettings = {
    enabled: true,
    initialNaming: { enabled: true, trigger: "messages", threshold: 1 },
    refreshNaming: { enabled: false, trigger: "turns", threshold: 10 },
    model: "current",
    reasoningEffort: "low",
    prompt: "Name {{reason}} in {{cwd}} from {{conversation}} and {{repository_context}}; current={{current_name}}.",
    nameConstraints: { minLength: 3, maxLength: 20 },
};

describe("session naming", () => {
    it("measures user messages, model turns, tool calls, and tokens", () => {
        const session = SessionManager.inMemory("/workspace/project");
        session.appendMessage({ role: "user", content: "Fix the parser", timestamp: 1 });
        session.appendMessage({
            role: "assistant",
            content: [
                { type: "text", text: "I will inspect the parser." },
                {
                    type: "toolCall",
                    id: "call-1",
                    name: "read",
                    arguments: { path: "src/parser.ts" },
                },
            ],
            api: "openai-responses",
            provider: "openai",
            model: "gpt-test",
            usage: {
                input: 10,
                output: 10,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 20,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 2,
        });
        session.appendMessage({
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            content: [{ type: "text", text: "Parser implementation" }],
            isError: false,
            timestamp: 3,
        });

        expect(measureSession(session.getBranch())).toEqual({
            messages: 1,
            turns: 1,
            toolCalls: 1,
            tokens: 20,
        });
        expect(buildConversationContext(session.getBranch())).toContain("Fix the parser");
        expect(buildConversationContext(session.getBranch())).toContain("tool call: read");
    });

    it("triggers initial naming after the first processed user message", () => {
        const state = createSessionNamingState(
            false,
            { messages: 0, turns: 0, toolCalls: 0, tokens: 0 },
            0,
        );

        expect(
            getNamingRequest(
                settings,
                state,
                { messages: 1, turns: 1, toolCalls: 0, tokens: 20 },
                0,
            ),
        ).toEqual({
            phase: "initial",
            trigger: "messages",
        });
    });

    it("triggers refreshes incrementally after the last name", () => {
        const refreshSettings: ExtensionSettings = {
            ...settings,
            initialNaming: { ...settings.initialNaming, enabled: false },
            refreshNaming: { enabled: true, trigger: "turns", threshold: 2 },
        };
        const state = createSessionNamingState(
            true,
            { messages: 1, turns: 2, toolCalls: 1, tokens: 30 },
            0,
        );

        expect(
            getNamingRequest(
                refreshSettings,
                state,
                { messages: 2, turns: 3, toolCalls: 1, tokens: 50 },
                1_000,
            ),
        ).toBeUndefined();
        expect(
            getNamingRequest(
                refreshSettings,
                state,
                { messages: 3, turns: 4, toolCalls: 1, tokens: 70 },
                1_000,
            ),
        ).toEqual({
            phase: "refresh",
            trigger: "turns",
        });
    });

    it("supports elapsed-time refresh triggers", () => {
        const timeSettings: ExtensionSettings = {
            ...settings,
            initialNaming: { ...settings.initialNaming, enabled: false },
            refreshNaming: { enabled: true, trigger: "minutes", threshold: 5 },
        };
        const state = createSessionNamingState(
            true,
            { messages: 1, turns: 1, toolCalls: 0, tokens: 10 },
            10_000,
        );

        expect(
            getNamingRequest(
                timeSettings,
                state,
                { messages: 1, turns: 1, toolCalls: 0, tokens: 10 },
                309_999,
            ),
        ).toBeUndefined();
        expect(
            getNamingRequest(
                timeSettings,
                state,
                { messages: 1, turns: 1, toolCalls: 0, tokens: 10 },
                310_000,
            ),
        ).toEqual({
            phase: "refresh",
            trigger: "minutes",
        });
    });

    it("normalizes picker output and enforces name length", () => {
        expect(normalizeSessionName('Session name: "Fix parser tests"\nExplanation', 3, 20)).toBe(
            "Fix parser tests",
        );
        expect(normalizeSessionName("ab", 3, 20)).toBeUndefined();
        expect(normalizeSessionName("A very long session name", 3, 10)).toBe("A very lon");
    });

    it("renders configurable prompt placeholders", () => {
        const prompt = renderNamingPrompt(
            "{{reason}} {{cwd}} {{current_name}} {{conversation}} {{repository_context}}",
            {
                reason: "initial",
                cwd: "/workspace/project",
                currentName: "(unnamed)",
                conversation: "Fix the parser",
                repositoryContext: "TypeScript project",
            },
            3,
            60,
        );

        expect(prompt).toContain(
            "initial /workspace/project (unnamed) Fix the parser TypeScript project",
        );
        expect(prompt).toContain("between 3 and 60 characters");
    });

    it("parses persisted state only when the complete shape is valid", () => {
        const state = createSessionNamingState(
            true,
            { messages: 1, turns: 1, toolCalls: 0, tokens: 10 },
            100,
        );

        expect(parseSessionNamingState(state)).toEqual(state);
        expect(
            parseSessionNamingState({ ...state, baseline: { messages: "one" } }),
        ).toBeUndefined();
    });

    it("includes the working directory and loaded repository guidance", () => {
        expect(
            buildRepositoryContext("/workspace/project", [
                { path: "AGENTS.md", content: "Use strict TypeScript." },
            ]),
        ).toContain("AGENTS.md");
    });
});
