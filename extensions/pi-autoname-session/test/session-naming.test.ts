import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { ExtensionSettings } from "../src/settings.ts";
import {
    buildConversationContext,
    buildRepositoryContext,
    createSessionNamingState,
    getNamingRequest,
    isOpaqueNamingPrompt,
    measureSession,
    normalizeSessionName,
    parseSessionNamingState,
    renderNamingPrompt,
} from "../src/session-naming.ts";

const settings: ExtensionSettings = {
    enabled: true,
    initialNaming: { enabled: true, timing: "prompt", trigger: "messages", threshold: 1 },
    refreshNaming: { enabled: false, trigger: "turns", threshold: 10 },
    model: { type: "current" },
    reasoningEffort: "low",
    timeoutMs: 30_000,
    conversationScope: "minimized",
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
        const context = buildConversationContext(session.getBranch(), {
            phase: "refresh",
            scope: "minimized",
        });
        expect(context).toContain("Fix the parser");
        expect(context).not.toContain("tool call: read");
    });

    it("triggers initial naming after the first processed user message", () => {
        const state = createSessionNamingState({
            initialNameSet: false,
            baseline: { messages: 0, turns: 0, toolCalls: 0, tokens: 0 },
            baselineAtMs: 0,
        });

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
        const state = createSessionNamingState({
            initialNameSet: true,
            baseline: { messages: 1, turns: 2, toolCalls: 1, tokens: 30 },
            baselineAtMs: 0,
        });

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
        const state = createSessionNamingState({
            initialNameSet: true,
            baseline: { messages: 1, turns: 1, toolCalls: 0, tokens: 10 },
            baselineAtMs: 10_000,
        });

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

    it("renders configurable prompt placeholders in a single pass", () => {
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

    it("does not reprocess placeholders inside substituted content", () => {
        const prompt = renderNamingPrompt(
            "{{conversation}}",
            {
                reason: "initial",
                cwd: "/workspace/project",
                currentName: "(unnamed)",
                conversation: 'The user typed "{{current_name}}" literally',
                repositoryContext: "",
            },
            3,
            60,
        );

        expect(prompt).toContain('The user typed "{{current_name}}" literally');
        expect(prompt).not.toContain("(unnamed) literally");
    });

    it("parses persisted state only when the complete shape is valid", () => {
        const state = createSessionNamingState({
            initialNameSet: true,
            baseline: { messages: 1, turns: 1, toolCalls: 0, tokens: 10 },
            baselineAtMs: 100,
        });

        expect(parseSessionNamingState(state)).toEqual(state);
        expect(
            parseSessionNamingState({ ...state, baseline: { messages: "one" } }),
        ).toBeUndefined();
        expect(parseSessionNamingState({ ...state, version: 2 })).toBeUndefined();
    });

    it("migrates legacy unversioned state and owns a copy of its baseline", () => {
        const baseline = { messages: 1, turns: 2, toolCalls: 3, tokens: 4 };
        const state = parseSessionNamingState({
            initialNameSet: true,
            baseline,
            baselineAtMs: 100,
        });

        baseline.messages = 99;
        expect(state).toEqual({
            version: 1,
            initialNameSet: true,
            baseline: { messages: 1, turns: 2, toolCalls: 3, tokens: 4 },
            baselineAtMs: 100,
        });
    });

    it("builds compact workspace metadata without repository guidance", () => {
        const context = buildRepositoryContext(
            "/workspace/project",
            "## feature/naming...origin/feature/naming\n M packages/one/src/index.ts\n M packages/one/test.ts\n?? src/new.ts\n",
        );

        expect(context).toContain("Repository: project");
        expect(context).toContain("Branch: feature/naming");
        expect(context).toContain("- packages/one");
        expect(context).toContain("- src/new.ts");
        expect(context).not.toContain("AGENTS.md");
    });

    it("recognizes opaque command and follow-up prompts", () => {
        expect(isOpaqueNamingPrompt("$commit")).toBe(true);
        expect(isOpaqueNamingPrompt("fix it please")).toBe(true);
        expect(isOpaqueNamingPrompt("continue working on OAuth refresh")).toBe(false);
        expect(isOpaqueNamingPrompt("Fix OAuth refresh races")).toBe(false);
    });

    it("uses only the first user request for initial naming", () => {
        const session = SessionManager.inMemory("/workspace/project");
        session.appendMessage({ role: "user", content: "Fix parser recovery", timestamp: 1 });
        session.appendMessage({ role: "user", content: "Then update the docs", timestamp: 2 });

        const context = buildConversationContext(session.getBranch(), {
            phase: "initial",
            scope: "minimized",
        });
        expect(context).toContain("Fix parser recovery");
        expect(context).not.toContain("Then update the docs");
    });

    it("pins the first user goal and recent tail within the refresh budget", () => {
        const session = SessionManager.inMemory("/workspace/project");
        session.appendMessage({
            role: "user",
            content: `first-goal ${"a".repeat(3_000)}`,
            timestamp: 1,
        });
        session.appendMessage({
            role: "user",
            content: `middle ${"b".repeat(5_000)}`,
            timestamp: 2,
        });
        session.appendMessage({
            role: "user",
            content: `latest-goal ${"c".repeat(2_000)}`,
            timestamp: 3,
        });

        const context = buildConversationContext(session.getBranch(), {
            phase: "refresh",
            scope: "minimized",
        });
        expect(context.length).toBeLessThanOrEqual(8_000);
        expect(context).toContain("first-goal");
        expect(context).toContain("latest-goal");
        expect(context).toContain("[Earlier conversation truncated]");
    });

    it("excludes tool results and shell output in minimized scope", () => {
        const session = SessionManager.inMemory("/workspace/project");
        session.appendMessage({ role: "user", content: "Deploy the service", timestamp: 1 });
        session.appendMessage({
            role: "assistant",
            content: [
                { type: "text", text: "I will deploy it now." },
                {
                    type: "toolCall",
                    id: "call-1",
                    name: "bash",
                    arguments: { command: "cat /etc/passwd" },
                },
            ],
            api: "openai-responses",
            provider: "openai",
            model: "gpt-test",
            usage: {
                input: 0,
                output: 10,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 10,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 2,
        });
        session.appendMessage({
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "bash",
            content: [{ type: "text", text: "root:x:0:0:root" }],
            isError: false,
            timestamp: 3,
        });

        const minimized = buildConversationContext(session.getBranch(), {
            phase: "refresh",
            scope: "minimized",
        });
        expect(minimized).toContain("Deploy the service");
        expect(minimized).toContain("I will deploy it now.");
        expect(minimized).not.toContain("tool call: bash");
        expect(minimized).not.toContain("cat /etc/passwd");
        expect(minimized).not.toContain("root:x:0:0:root");

        const full = buildConversationContext(session.getBranch(), {
            phase: "refresh",
            scope: "full",
        });
        expect(full).toContain("cat /etc/passwd");
        expect(full).toContain("root:x:0:0:root");
    });

    it("serializes cyclic and bigint tool arguments safely in full scope", () => {
        const session = SessionManager.inMemory("/workspace/project");
        type CyclicArguments = {
            readonly count: bigint;
            readonly notFinite: number;
            self?: CyclicArguments;
        };
        const cyclicArguments: CyclicArguments = { count: 10n, notFinite: Number.NaN };
        cyclicArguments.self = cyclicArguments;
        session.appendMessage({ role: "user", content: "Inspect arguments", timestamp: 1 });
        session.appendMessage({
            role: "assistant",
            content: [
                {
                    type: "toolCall",
                    id: "call-1",
                    name: "inspect",
                    arguments: cyclicArguments,
                },
            ],
            api: "openai-responses",
            provider: "openai",
            model: "gpt-test",
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 2,
        });

        const full = buildConversationContext(session.getBranch(), {
            phase: "refresh",
            scope: "full",
        });
        expect(full).toContain('"count":"10"');
        expect(full).toContain('"notFinite":null');
        expect(full).toContain('"self":"[circular]"');
    });
});
