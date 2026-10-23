import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    createAgentSession,
    DefaultResourceLoader,
    type ExtensionAPI,
    type ExtensionFactory,
    ModelRuntime,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { registerSystemPromptPreparation } from "@zigai/pi-extension-internals/prompt-preparation";
import {
    createAssistantMessageEventStream,
    getCurrentSystemPrompt,
    InMemoryCredentialStore,
    type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
    ACTIVATION_PROPOSAL_ACCEPTED_EVENT,
    ACTIVATION_READY_EVENT,
    CLEAR_ACTIVATION_PROPOSAL_EVENT,
    parseActivationProposalOwner,
    parseActivationReady,
    SET_ACTIVATION_PROPOSAL_EVENT,
    type ExtensionActivationProposal,
} from "./activation-coordination.ts";
import codexExtension from "@zigai/pi-codex-core";
import extension from "./index.ts";
import { TogglesService } from "./toggles-service.ts";
import type { Profile } from "./settings.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

async function createLoader(
    cwd: string,
    agentDir: string,
    noSkills = true,
    extensionFactories: Array<{ readonly name: string; readonly factory: ExtensionFactory }> = [
        { name: "pi-toggles-test", factory: extension },
    ],
    additionalExtensionPaths: string[] = [],
): Promise<DefaultResourceLoader> {
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        extensionFactories,
        additionalExtensionPaths,
        noSkills,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
    });
    await loader.reload();
    return loader;
}

async function syntheticRuntime(
    requests: string[],
    reasoning = false,
    credentials = new InMemoryCredentialStore(),
): Promise<ModelRuntime> {
    const runtime = await ModelRuntime.create({
        credentials,
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
    });
    const models = ["first", "second", "manual", "small", "gpt-5.5"].map((id) => ({
        id,
        name: id,
        reasoning,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10000,
        maxTokens: 100,
    }));
    runtime.registerProvider("synthetic", {
        api: "preset-test",
        apiKey: "test-key",
        baseUrl: "https://example.invalid",
        models,
        streamSimple(model) {
            requests.push(model.id);
            const stream = createAssistantMessageEventStream();
            const message: AssistantMessage = {
                role: "assistant",
                content: [{ type: "text", text: "Synthetic response" }],
                api: model.api,
                provider: model.provider,
                model: model.id,
                timestamp: 1,
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
            };
            stream.push({ type: "done", reason: "stop", message });
            stream.end(message);
            return stream;
        },
    });
    runtime.registerProvider("uncredentialed", {
        api: "openai-completions",
        baseUrl: "https://example.invalid",
        models,
    });
    return runtime;
}

function createProposalExtension(decisions: ExtensionActivationProposal["decisions"]): {
    readonly factory: (pi: ExtensionAPI) => void;
    readonly acceptedSessions: string[];
    readonly clearProposal: (sessionId: string) => void;
} {
    const acceptedSessions: string[] = [];
    let extensionApi: ExtensionAPI | undefined;
    return {
        acceptedSessions,
        clearProposal(sessionId) {
            if (extensionApi === undefined) throw new Error("Companion extension is not loaded.");
            extensionApi.events.emit(CLEAR_ACTIVATION_PROPOSAL_EVENT, {
                version: 1,
                sessionId,
                owner: "test-companion",
            });
        },
        factory(pi) {
            extensionApi = pi;
            pi.events.on(ACTIVATION_READY_EVENT, (value) => {
                const ready = parseActivationReady(value);
                if (ready.status === "invalid") return;
                pi.events.emit(SET_ACTIVATION_PROPOSAL_EVENT, {
                    version: 1,
                    sessionId: ready.value.sessionId,
                    owner: "test-companion",
                    decisions,
                });
            });
            pi.events.on(ACTIVATION_PROPOSAL_ACCEPTED_EVENT, (value) => {
                const accepted = parseActivationProposalOwner(value);
                if (accepted.status === "ok" && accepted.value.owner === "test-companion") {
                    acceptedSessions.push(accepted.value.sessionId);
                }
            });
        },
    };
}

describe("Pi Toggles extension runtime", () => {
    it.each([
        ["missing mode owner", { modelMode: "focused" }],
        ["rejected mode selection", { modelMode: "rejected" }],
        [
            "unavailable model",
            { modelRoles: { main: { provider: "synthetic", modelId: "absent" } } },
        ],
        [
            "missing credentials",
            { modelRoles: { main: { provider: "uncredentialed", modelId: "small" } } },
        ],
        ["dangling main role", { modelRoles: { main: "@absent" } }],
    ] satisfies ReadonlyArray<readonly [string, Partial<Profile>]>)(
        "cancels the active turn instead of sending on the old model after %s",
        async (_scenario, selection) => {
            const root = await mkdtemp(join(tmpdir(), "pi-toggles-preset-failure-"));
            temporaryDirectories.push(root);
            const cwd = join(root, "project");
            const agentDir = join(root, "agent");
            await mkdir(cwd, { recursive: true });
            await mkdir(join(agentDir, "extension-settings"), { recursive: true });
            await writeFile(
                join(agentDir, "extension-settings", "pi-toggles.json"),
                JSON.stringify({
                    activeProfile: "focused",
                    profiles: { focused: { decisions: [], promptFragments: [], ...selection } },
                }),
            );
            const requests: string[] = [];
            const errors: string[] = [];
            const modelRuntime = await syntheticRuntime(requests);
            const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
            process.env.PI_CODING_AGENT_DIR = agentDir;
            try {
                const loader = await createLoader(cwd, agentDir, true, [
                    { name: "toggles", factory: extension },
                    {
                        name: "mode-owner",
                        factory(pi) {
                            pi.events.on("pi-model-modes:select", (value) => {
                                const query = Type.Object(
                                    {
                                        mode: Type.String(),
                                        accept: Type.Function([Type.Unknown()], Type.Void()),
                                    },
                                    { additionalProperties: true },
                                );
                                const request = Compile(query).Parse(value);
                                if (request.mode === "rejected")
                                    request.accept(Promise.reject(new Error("credential-secret")));
                            });
                        },
                    },
                ]);
                const model = modelRuntime.getModel("synthetic", "first");
                if (model === undefined) throw new Error("Synthetic model unavailable");
                const { session } = await createAgentSession({
                    cwd,
                    agentDir,
                    modelRuntime,
                    model,
                    resourceLoader: loader,
                    sessionManager: SessionManager.inMemory(cwd),
                    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
                });
                await session.bindExtensions({
                    mode: "print",
                    onError: (error) => {
                        errors.push(error.error);
                    },
                });
                try {
                    await session.prompt("Sample task");
                    expect(requests).toEqual([]);
                    expect(errors).toEqual(["Preset focused model selection failed."]);
                    expect(session.model?.id).toBe("first");
                } finally {
                    session.dispose();
                }
            } finally {
                if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
                else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
        },
    );

    it.each([
        "invalid profile",
        "blocked profile",
        "blocked reset",
        "invalid panel",
        "blocked panel",
        "invalid persisted profile",
        "invalid persisted reset",
        "invalid persisted panel",
    ] as const)("preserves the manual model after a rejected policy edit: %s", async (scenario) => {
        const root = await mkdtemp(join(tmpdir(), "pi-toggles-rejected-policy-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "project");
        const agentDir = join(root, "agent");
        await mkdir(cwd, { recursive: true });
        await mkdir(join(agentDir, "extension-settings"), { recursive: true });
        await writeFile(
            join(agentDir, "extension-settings", "pi-toggles.json"),
            JSON.stringify({
                profiles: {
                    focused: {
                        decisions: [],
                        promptFragments: [],
                        modelRoles: { main: { provider: "synthetic", modelId: "second" } },
                    },
                },
                activeProfile: "focused",
            }),
        );
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        let service: TogglesService | undefined;
        try {
            const modelRuntime = await syntheticRuntime([]);
            const loader = await createLoader(cwd, agentDir, true, [
                {
                    name: "service-owner",
                    factory(pi) {
                        pi.on("session_start", async (_event, ctx) => {
                            service = new TogglesService(pi, {
                                ...ctx,
                                isProjectTrusted: () => false,
                            });
                            await service.initialize();
                        });
                        pi.on("model_select", () => {
                            service?.noteModelSelection();
                        });
                    },
                },
            ]);
            const model = modelRuntime.getModel("synthetic", "first");
            if (model === undefined) throw new Error("Synthetic model unavailable");
            const { session } = await createAgentSession({
                cwd,
                agentDir,
                modelRuntime,
                model,
                resourceLoader: loader,
                sessionManager: SessionManager.inMemory(cwd),
                settingsManager: SettingsManager.inMemory(),
            });
            await session.bindExtensions({ mode: "print" });
            try {
                if (service === undefined) throw new Error("Service unavailable");
                await service.applyPreset();
                const manual = modelRuntime.getModel("synthetic", "manual");
                if (manual === undefined) throw new Error("Manual model unavailable");
                await session.setModel(manual);
                if (scenario.startsWith("invalid persisted")) {
                    await writeFile(
                        join(agentDir, "extension-settings", "pi-toggles.json"),
                        "invalid-json",
                    );
                }
                let result;
                if (scenario === "invalid persisted profile")
                    result = await service.setActiveProfile("global", "focused");
                else if (scenario === "invalid persisted reset")
                    result = await service.clearScope("global");
                else if (scenario === "invalid persisted panel")
                    result = await service.applyPanelPolicy("global", [], undefined);
                else if (scenario === "invalid profile")
                    result = await service.setActiveProfile("session", "absent");
                else if (scenario === "blocked profile")
                    result = await service.setActiveProfile("project", "focused");
                else if (scenario === "blocked reset") result = await service.clearScope("project");
                else if (scenario === "invalid panel")
                    result = await service.applyPanelPolicy("session", [], "absent");
                else result = await service.applyPanelPolicy("project", [], "focused");
                let expectedStatus = "blocked";
                if (scenario.startsWith("invalid")) expectedStatus = "invalid";
                expect(result.status).toBe(expectedStatus);
                await service.preparePrompt("Sample task", {});
                expect(session.model?.id).toBe("manual");
                expect(service.getActiveProfile("global")).toBe("focused");
            } finally {
                service?.dispose();
                session.dispose();
            }
        } finally {
            if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        }
    });
    it.each(["active", "replaced", "shutdown"] as const)(
        "prompt preparation completion respects its %s activation owner",
        async (owner) => {
            const root = await mkdtemp(join(tmpdir(), "pi-toggles-preparation-"));
            temporaryDirectories.push(root);
            const cwd = join(root, "project");
            const agentDir = join(root, "agent");
            await mkdir(cwd, { recursive: true });
            await mkdir(join(agentDir, "extension-settings"), { recursive: true });
            await writeFile(
                join(agentDir, "extension-settings", "pi-toggles.json"),
                JSON.stringify({
                    promptFragments: [
                        {
                            id: "selected",
                            operation: "replace",
                            priority: 0,
                            content: { kind: "inline", text: "Selected instructions" },
                        },
                    ],
                }),
            );
            const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
            let enter!: () => void;
            let rejectPreparation!: (cause: Error) => void;
            const entered = new Promise<void>((resolve) => {
                enter = resolve;
            });
            const preparation = new Promise<void>((_resolve, reject) => {
                rejectPreparation = reject;
            });
            const errors: string[] = [];
            let cancellations = 0;
            let unregister: (() => void) | undefined;
            process.env.PI_CODING_AGENT_DIR = agentDir;
            try {
                const loader = await createLoader(cwd, agentDir, true, [
                    { name: "toggles", factory: extension },
                    {
                        name: "preparer",
                        factory(pi) {
                            unregister = registerSystemPromptPreparation(pi.events, () => {
                                enter();
                                return preparation;
                            });
                        },
                    },
                ]);
                const modelRuntime = await ModelRuntime.create({
                    credentials: new InMemoryCredentialStore(),
                    modelsPath: null,
                    refreshOnCreate: false,
                    allowModelNetwork: false,
                });
                const { session } = await createAgentSession({
                    cwd,
                    agentDir,
                    modelRuntime,
                    resourceLoader: loader,
                    sessionManager: SessionManager.inMemory(cwd),
                    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
                });
                await session.bindExtensions({
                    mode: "print",
                    abortHandler: () => {
                        cancellations += 1;
                    },
                    onError: (error) => {
                        errors.push(error.error);
                    },
                });
                try {
                    const operation = session.extensionRunner.emitBeforeAgentStart(
                        { messageType: "user", prompt: "Sample task" },
                        { cwd },
                    );
                    await entered;
                    if (owner === "replaced") {
                        await session.extensionRunner.emit({
                            type: "session_start",
                            reason: "new",
                        });
                    }
                    if (owner === "shutdown") {
                        await session.extensionRunner.emit({
                            type: "session_shutdown",
                            reason: "quit",
                        });
                    }
                    rejectPreparation(new Error("Preparation rejected"));
                    const result = await operation;
                    expect(cancellations).toBe(owner === "active" ? 1 : 0);
                    expect(result.systemPromptOptions.forceSystemPrompt).toBeUndefined();
                    expect(errors).toEqual(["Preparation rejected"]);
                    unregister?.();
                    await session.extensionRunner.emitBeforeAgentStart(
                        { messageType: "user", prompt: "Repaired task" },
                        { cwd },
                    );
                    expect(cancellations).toBe(owner === "active" ? 1 : 0);
                } finally {
                    unregister?.();
                    await session.extensionRunner.emit({
                        type: "session_shutdown",
                        reason: "quit",
                    });
                    session.dispose();
                }
            } finally {
                if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
                else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
        },
    );
    it("enforces an active Goal restriction over manual enabling and resumes manual policy after time limitation", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-toggles-goal-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "project");
        const agentDir = join(root, "agent");
        await mkdir(cwd, { recursive: true });
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        let api: ExtensionAPI | undefined;
        let questionCalls = 0;
        try {
            const loader = await createLoader(cwd, agentDir, true, [
                { name: "toggles", factory: extension },
                {
                    name: "goal-owner",
                    factory(pi) {
                        api = pi;
                    },
                },
            ]);
            const { session } = await createAgentSession({
                cwd,
                agentDir,
                resourceLoader: loader,
                sessionManager: SessionManager.inMemory(cwd),
                settingsManager: SettingsManager.inMemory(),
            });
            await session.bindExtensions({ mode: "print" });
            try {
                if (api === undefined) throw new Error("Goal owner unavailable");
                api.events.emit("pi-goal:tool-policy", {
                    version: 1,
                    sessionId: session.sessionManager.getSessionId(),
                    status: "active",
                    disabledTools: ["ask_user_question"],
                });
                api.registerTool({
                    name: "ask_user_question",
                    label: "Question",
                    description: "Synthetic question",
                    exposure: "deferred",
                    parameters: Type.Object({}),
                    async execute() {
                        questionCalls += 1;
                        return { content: [{ type: "text", text: "answer" }], details: undefined };
                    },
                });
                api.registerTool({
                    name: "invoke_question",
                    label: "Invoke",
                    description: "Nested question",
                    parameters: Type.Object({}),
                    async execute(_id, _args, _signal, _update, ctx) {
                        const result = await ctx.executeTool("ask_user_question", {});
                        return { content: result.result.content, details: result };
                    },
                });
                await session.prompt("/toggles set ask_user_question on --scope session");
                expect(api.getActiveTools()).not.toContain("ask_user_question");
                expect(
                    await session.extensionRunner.emitToolCall({
                        type: "tool_call",
                        toolCallId: "question",
                        toolName: "ask_user_question",
                        input: {},
                    }),
                ).toMatchObject({ block: true });
                api.events.emit("pi-goal:tool-policy", {
                    version: 1,
                    sessionId: session.sessionManager.getSessionId(),
                    status: "timeLimited",
                    disabledTools: ["ask_user_question"],
                });
                await session.prompt("/toggles list tool");
                expect(
                    await session.extensionRunner.emitToolCall({
                        type: "tool_call",
                        toolCallId: "after-goal",
                        toolName: "ask_user_question",
                        input: {},
                    }),
                ).toBeUndefined();
                await session.prompt("/toggles set ask_user_question off --scope session");
                api.events.emit("pi-goal:tool-policy", {
                    version: 1,
                    sessionId: session.sessionManager.getSessionId(),
                    status: "active",
                    disabledTools: ["ask_user_question"],
                });
                session.agent.state.messages = [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                id: "outer",
                                name: "invoke_question",
                                arguments: {},
                            },
                        ],
                        api: "openai-responses",
                        provider: "synthetic",
                        model: "synthetic",
                        usage: {
                            input: 0,
                            output: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                            totalTokens: 0,
                            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                        },
                        stopReason: "toolUse",
                        timestamp: 1,
                    },
                ];
                const nested = session.agent.state.tools.find(
                    (tool) => tool.name === "invoke_question",
                );
                if (nested === undefined) throw new Error("Nested tool unavailable");
                expect((await nested.execute("outer", {})).details).toMatchObject({
                    isError: true,
                });
                expect(questionCalls).toBe(0);
                api.events.emit("pi-goal:tool-policy", {
                    version: 1,
                    sessionId: session.sessionManager.getSessionId(),
                    status: "timeLimited",
                    disabledTools: ["ask_user_question"],
                });
                expect(
                    await session.extensionRunner.emitToolCall({
                        type: "tool_call",
                        toolCallId: "manually-disabled",
                        toolName: "ask_user_question",
                        input: {},
                    }),
                ).toMatchObject({ block: true });
                await session.prompt("/toggles reset ask_user_question --scope session");
                expect(
                    await session.extensionRunner.emitToolCall({
                        type: "tool_call",
                        toolCallId: "restored",
                        toolName: "ask_user_question",
                        input: {},
                    }),
                ).toBeUndefined();
            } finally {
                session.dispose();
            }
        } finally {
            if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        }
    });

    it("clears user prompt policy on custom starts while retaining model policy and custom content", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-toggles-custom-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "project");
        const agentDir = join(root, "agent");
        await mkdir(cwd, { recursive: true });
        await mkdir(join(agentDir, "extension-settings"), { recursive: true });
        await writeFile(
            join(agentDir, "extension-settings", "pi-toggles.json"),
            JSON.stringify({
                rules: [
                    {
                        id: "user-policy",
                        priority: 0,
                        when: { fact: "prompt.text", contains: "focus" },
                        decisions: [{ target: { kind: "tool", name: "write" }, state: "off" }],
                        activateProfiles: [],
                    },
                ],
                promptFragments: [
                    {
                        id: "user",
                        priority: 0,
                        operation: "replace",
                        content: { kind: "inline", text: "User replacement" },
                        when: { fact: "prompt.text", contains: "focus" },
                    },
                    {
                        id: "model",
                        priority: 0,
                        content: { kind: "inline", text: "Model guidance" },
                        when: { fact: "model.provider", equals: "synthetic" },
                    },
                ],
            }),
        );
        const prompts: string[] = [];
        const errors: string[] = [];
        const modelRuntime = await ModelRuntime.create({
            credentials: new InMemoryCredentialStore(),
            modelsPath: null,
            refreshOnCreate: false,
        });
        modelRuntime.registerProvider("synthetic", {
            api: "custom-start-test",
            apiKey: "synthetic-key",
            baseUrl: "https://example.invalid",
            models: [
                {
                    id: "small",
                    name: "Small",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 10000,
                    maxTokens: 100,
                },
            ],
            streamSimple(model, context) {
                prompts.push(getCurrentSystemPrompt(context.messages));
                const stream = createAssistantMessageEventStream();
                const message: AssistantMessage = {
                    role: "assistant",
                    content: [{ type: "text", text: "Synthetic response" }],
                    api: model.api,
                    provider: model.provider,
                    model: model.id,
                    timestamp: 1,
                    usage: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 0,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    },
                    stopReason: "stop",
                };
                stream.push({ type: "start", partial: message });
                stream.push({ type: "done", reason: "stop", message });
                stream.end(message);
                return stream;
            },
        });
        const model = modelRuntime.getModel("synthetic", "small");
        if (model === undefined) throw new Error("Synthetic model unavailable");
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        try {
            const loader = await createLoader(cwd, agentDir);
            const { session } = await createAgentSession({
                cwd,
                agentDir,
                modelRuntime,
                model,
                resourceLoader: loader,
                sessionManager: SessionManager.inMemory(cwd),
                settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
            });
            await session.bindExtensions({
                mode: "print",
                onError: (error) => {
                    errors.push(error.error);
                },
            });
            try {
                await session.sendCustomMessage(
                    {
                        customType: "background-work",
                        content: "focus initial custom work",
                        display: false,
                    },
                    { triggerTurn: true },
                );
                expect(prompts[0]).toContain("Model guidance");
                expect(prompts[0]).not.toContain("User replacement");

                await session.prompt("focus user work");
                expect(prompts[1]).toBe(
                    "User replacement\n\n## Pi Toggles: model\n\nModel guidance",
                );
                expect(session.getActiveToolNames()).not.toContain("write");

                const content = [{ type: "text" as const, text: "focus later custom work" }];
                await session.sendCustomMessage(
                    { customType: "background-work", content, display: false },
                    { triggerTurn: true },
                );
                expect(prompts).toHaveLength(3);
                expect(prompts[2]).not.toContain("User replacement");
                expect(prompts[2]?.match(/Model guidance/g)).toHaveLength(1);
                expect(session.getActiveToolNames()).toContain("write");
                expect(session.messages).toContainEqual(
                    expect.objectContaining({ role: "custom", content }),
                );
                expect(errors).toEqual([]);
            } finally {
                session.dispose();
            }
        } finally {
            if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        }
    });

    it.each([
        ["pi", "append"],
        ["codex", "append"],
        ["pi", "replace"],
        ["codex", "replace"],
    ] as const)(
        "preserves unowned prompt additions between Toggles and Codex in %s prompt mode with an owned %s",
        async (mode, operation) => {
            const root = await mkdtemp(join(tmpdir(), "pi-toggles-prompt-interop-"));
            temporaryDirectories.push(root);
            const cwd = join(root, "project");
            const agentDir = join(root, "agent");
            await mkdir(cwd, { recursive: true });
            await mkdir(join(agentDir, "extension-settings"), { recursive: true });
            await writeFile(
                join(agentDir, "extension-settings", "pi-toggles.json"),
                JSON.stringify({
                    promptFragments: [
                        {
                            id: "guide",
                            priority: 0,
                            operation,
                            content: { kind: "inline", text: "Owned guidance" },
                            when: { fact: "session.mode", equals: "print" },
                        },
                    ],
                }),
            );
            await writeFile(
                join(agentDir, "extension-settings", "pi-codex-core.json"),
                JSON.stringify({ prompt: { mode }, compaction: { enabled: false } }),
            );
            const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
            process.env.PI_CODING_AGENT_DIR = agentDir;
            try {
                const loader = await createLoader(cwd, agentDir, true, [
                    { name: "toggles", factory: extension },
                    {
                        name: "appender",
                        factory(pi) {
                            pi.on("before_agent_start", (event) => ({
                                systemPrompt: `${event.systemPrompt}\n\nIndependent addition`,
                            }));
                        },
                    },
                    { name: "codex", factory: codexExtension },
                ]);
                const modelRuntime = await syntheticRuntime([]);
                const model = modelRuntime.getModel("synthetic", "gpt-5.5");
                if (model === undefined) throw new Error("GPT model unavailable");
                const { session } = await createAgentSession({
                    cwd,
                    agentDir,
                    modelRuntime,
                    model,
                    resourceLoader: loader,
                    sessionManager: SessionManager.inMemory(cwd),
                    settingsManager: SettingsManager.inMemory(),
                });
                await session.bindExtensions({ mode: "print" });
                try {
                    const result = await session.extensionRunner.emitBeforeAgentStart(
                        { messageType: "user", prompt: "Sample task" },
                        { cwd },
                    );
                    if (mode === "codex" && operation === "append")
                        expect(result.systemPromptOptions.forceSystemPrompt).toContain(
                            "You are Codex",
                        );
                    expect(
                        result.systemPromptOptions.forceSystemPrompt?.match(
                            /Independent addition/g,
                        ),
                    ).toHaveLength(1);
                    expect(
                        result.systemPromptOptions.forceSystemPrompt?.match(/Owned guidance/g),
                    ).toHaveLength(1);
                } finally {
                    await session.extensionRunner.emit({
                        type: "session_shutdown",
                        reason: "quit",
                    });
                    session.dispose();
                }
            } finally {
                if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
                else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
        },
    );

    it.each([
        ["role", "listener", "model"],
        ["role", "listener", "thinking"],
        ["role", "auth", "model"],
        ["role", "auth", "thinking"],
        ["mode", "listener", "model"],
        ["mode", "listener", "thinking"],
        ["mode", "auth", "model"],
        ["mode", "auth", "thinking"],
        ["role", "listener", "mode"],
        ["role", "auth", "mode"],
        ["mode", "listener", "mode"],
        ["mode", "auth", "mode"],
        ["role", "listener", "none"],
        ["mode", "listener", "none"],
    ] as const)(
        "preserves selection ownership for a %s preset during pending %s (%s choice)",
        async (selection, window, choice) => {
            const root = await mkdtemp(join(tmpdir(), "pi-toggles-preset-race-"));
            temporaryDirectories.push(root);
            const cwd = join(root, "project");
            const agentDir = join(root, "agent");
            await mkdir(cwd, { recursive: true });
            await mkdir(join(agentDir, "extension-settings"), { recursive: true });
            const second = {
                provider: "synthetic",
                modelId: "second",
                thinkingLevel: "high",
            } as const;
            const small = {
                provider: "synthetic",
                modelId: "small",
                thinkingLevel: "high",
            } as const;
            let focused: Partial<Profile> = { modelRoles: { main: second } };
            let later: Partial<Profile> = { modelRoles: { main: small } };
            if (selection === "mode") {
                focused = { modelMode: "focused" };
                later = { modelMode: "later" };
            }
            await writeFile(
                join(agentDir, "extension-settings", "pi-toggles.json"),
                JSON.stringify({
                    profiles: {
                        focused: { decisions: [], promptFragments: [], ...focused },
                        later: { decisions: [], promptFragments: [], ...later },
                    },
                    rules: ["focused", "later"].map((name) => ({
                        id: name,
                        priority: 0,
                        when: { fact: "prompt.text", contains: name },
                        decisions: [],
                        activateProfiles: [name],
                    })),
                }),
            );
            await writeFile(
                join(agentDir, "extension-settings", "pi-model-modes.json"),
                JSON.stringify({
                    modes: {
                        default: { provider: "synthetic", modelId: "first" },
                        focused: second,
                        later: small,
                        manualMode: {},
                    },
                }),
            );
            let signalEntered: () => void = () => {};
            let release: () => void = () => {};
            const entered = new Promise<void>((resolve) => {
                signalEntered = resolve;
            });
            const pending = new Promise<void>((resolve) => {
                release = resolve;
            });
            let armed = false;
            class GatedCredentials extends InMemoryCredentialStore {
                override async read(...args: Parameters<InMemoryCredentialStore["read"]>) {
                    if (window === "auth" && armed && args[0] === "synthetic") {
                        armed = false;
                        signalEntered();
                        await pending;
                    }
                    return super.read(...args);
                }
            }
            let api: ExtensionAPI | undefined;
            const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
            process.env.PI_CODING_AGENT_DIR = agentDir;
            try {
                const modelRuntime = await syntheticRuntime([], true, new GatedCredentials());
                const first = modelRuntime.getModel("synthetic", "first");
                const manual = modelRuntime.getModel("synthetic", "manual");
                if (first === undefined || manual === undefined)
                    throw new Error("Models unavailable");
                const loader = await createLoader(
                    cwd,
                    agentDir,
                    true,
                    [
                        {
                            name: "selection-gate",
                            factory(pi) {
                                api = pi;
                                pi.on("model_select", async (event) => {
                                    if (
                                        window === "listener" &&
                                        armed &&
                                        event.model.id === "second"
                                    ) {
                                        armed = false;
                                        signalEntered();
                                        await pending;
                                    }
                                });
                            },
                        },
                    ],
                    [
                        fileURLToPath(import.meta.resolve("@zigai/pi-toggles")),
                        fileURLToPath(import.meta.resolve("@zigai/pi-model-modes")),
                    ],
                );
                expect(loader.getExtensions().errors).toEqual([]);
                const { session } = await createAgentSession({
                    cwd,
                    agentDir,
                    modelRuntime,
                    model: first,
                    resourceLoader: loader,
                    sessionManager: SessionManager.inMemory(cwd),
                    settingsManager: SettingsManager.inMemory(),
                });
                const errors: string[] = [];
                session.extensionRunner.onError((event) => {
                    errors.push(event.error);
                });
                await session.bindExtensions({ mode: "print" });
                let operation: Promise<unknown> | undefined;
                try {
                    armed = true;
                    operation = session.extensionRunner.emitBeforeAgentStart(
                        { messageType: "user", prompt: "focused task" },
                        { cwd },
                    );
                    await entered;
                    if (choice === "model") await session.setModel(manual);
                    if (choice === "model" || choice === "thinking")
                        session.setThinkingLevel("low");
                    if (choice === "mode") {
                        if (api === undefined) throw new Error("Mode selection API unavailable");
                        let manualOperation: Promise<void> | undefined;
                        api.events.emit("pi-model-modes:select", {
                            version: 1,
                            sessionId: session.sessionManager.getSessionId(),
                            mode: "manualMode",
                            accept(value: Promise<void>) {
                                manualOperation = value;
                            },
                        });
                        if (manualOperation === undefined)
                            throw new Error("Mode owner unavailable");
                        await manualOperation;
                    }
                    let expectedModel = session.model?.id;
                    let expectedThinking = session.thinkingLevel;
                    if (choice === "none") {
                        expectedModel = "second";
                        expectedThinking = "high";
                    }
                    release();
                    await operation;
                    expect(errors).toEqual([]);
                    expect(session.model?.id).toBe(expectedModel);
                    expect(session.thinkingLevel).toBe(expectedThinking);
                    await session.extensionRunner.emitBeforeAgentStart(
                        { messageType: "user", prompt: "later task" },
                        { cwd },
                    );
                    expect(errors).toEqual([]);
                    if (choice === "none") expectedModel = "small";
                    expect(session.model?.id).toBe(expectedModel);
                    expect(session.thinkingLevel).toBe(expectedThinking);
                } finally {
                    release();
                    await operation;
                    await session.extensionRunner.emit({
                        type: "session_shutdown",
                        reason: "quit",
                    });
                    session.dispose();
                }
            } finally {
                release();
                if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
                else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
        },
    );

    it.each([
        ["toggles-first", false],
        ["modes-first", false],
        ["toggles-first", true],
        ["modes-first", true],
    ] as const)(
        "applies presets after a startup model default and respects manual overrides (%s, manual before turn: %s)",
        async (order, manualBeforeTurn) => {
            const root = await mkdtemp(join(tmpdir(), "pi-toggles-startup-model-"));
            temporaryDirectories.push(root);
            const cwd = join(root, "project");
            const agentDir = join(root, "agent");
            await mkdir(cwd, { recursive: true });
            await mkdir(join(agentDir, "extension-settings"), { recursive: true });
            await writeFile(
                join(agentDir, "extension-settings", "pi-toggles.json"),
                JSON.stringify({
                    activeProfile: "focused",
                    profiles: {
                        focused: {
                            decisions: [],
                            promptFragments: [],
                            modelRoles: { main: { provider: "synthetic", modelId: "second" } },
                        },
                    },
                }),
            );
            const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
            process.env.PI_CODING_AGENT_DIR = agentDir;
            try {
                const modelRuntime = await syntheticRuntime([]);
                const startup = modelRuntime.getModel("synthetic", "first");
                const manual = modelRuntime.getModel("synthetic", "manual");
                if (startup === undefined || manual === undefined)
                    throw new Error("Models unavailable");
                await writeFile(
                    join(agentDir, "extension-settings", "pi-model-modes.json"),
                    JSON.stringify({
                        defaultModel: { provider: "synthetic", modelId: "first" },
                        modes: { default: { provider: "synthetic", modelId: "first" } },
                    }),
                );
                const modes = fileURLToPath(import.meta.resolve("@zigai/pi-model-modes"));
                const toggles = fileURLToPath(import.meta.resolve("@zigai/pi-toggles"));
                let extensionPaths = [modes, toggles];
                if (order === "toggles-first") extensionPaths = [toggles, modes];
                const loader = await createLoader(cwd, agentDir, true, [], extensionPaths);
                expect(loader.getExtensions().errors).toEqual([]);
                const { session } = await createAgentSession({
                    cwd,
                    agentDir,
                    modelRuntime,
                    model: manual,
                    resourceLoader: loader,
                    sessionManager: SessionManager.inMemory(cwd),
                    settingsManager: SettingsManager.inMemory(),
                });
                await session.bindExtensions({ mode: "print" });
                try {
                    expect(session.model?.id).toBe("first");
                    if (manualBeforeTurn) await session.setModel(manual);
                    await session.extensionRunner.emitBeforeAgentStart(
                        { messageType: "user", prompt: "Sample task" },
                        { cwd },
                    );
                    let expectedModel = "second";
                    if (manualBeforeTurn) expectedModel = "manual";
                    expect(session.model?.id).toBe(expectedModel);
                    await session.setModel(manual);
                    await session.extensionRunner.emitBeforeAgentStart(
                        { messageType: "user", prompt: "Another task" },
                        { cwd },
                    );
                    expect(session.model?.id).toBe("manual");
                } finally {
                    await session.extensionRunner.emit({
                        type: "session_shutdown",
                        reason: "quit",
                    });
                    session.dispose();
                }
            } finally {
                if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
                else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
        },
    );

    it.each(["new", "resume", "fork"] as const)(
        "resolves the compaction model role after a non-final session shutdown and start (%s)",
        async (reason) => {
            const root = await mkdtemp(join(tmpdir(), "pi-toggles-role-lifecycle-"));
            temporaryDirectories.push(root);
            const cwd = join(root, "project");
            const agentDir = join(root, "agent");
            await mkdir(cwd, { recursive: true });
            await mkdir(join(agentDir, "extension-settings"), { recursive: true });
            await writeFile(
                join(agentDir, "extension-settings", "pi-toggles.json"),
                JSON.stringify({
                    profiles: {
                        focused: {
                            decisions: [],
                            promptFragments: [],
                            modelRoles: {
                                compaction: { provider: "synthetic", modelId: "compact" },
                            },
                        },
                    },
                }),
            );
            const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
            process.env.PI_CODING_AGENT_DIR = agentDir;
            let api: ExtensionAPI | undefined;
            try {
                const loader = await createLoader(cwd, agentDir, true, [
                    { name: "toggles", factory: extension },
                    {
                        name: "role-consumer",
                        factory(pi) {
                            api = pi;
                        },
                    },
                ]);
                const { session } = await createAgentSession({
                    cwd,
                    agentDir,
                    resourceLoader: loader,
                    sessionManager: SessionManager.inMemory(cwd),
                    settingsManager: SettingsManager.inMemory(),
                });
                try {
                    await session.bindExtensions({ mode: "print" });
                    await session.prompt("/toggles profile focused --scope global");
                    if (api === undefined) throw new Error("Role consumer unavailable");
                    let before: unknown;
                    api.events.emit("pi-toggles:model-role", {
                        version: 1,
                        role: "compaction",
                        accept: (value: unknown) => {
                            before = value;
                        },
                    });
                    expect(before).toEqual({
                        status: "resolved",
                        model: { provider: "synthetic", modelId: "compact" },
                    });

                    await session.extensionRunner.emit({ type: "session_shutdown", reason });
                    await session.extensionRunner.emit({ type: "session_start", reason });

                    let after: unknown;
                    api.events.emit("pi-toggles:model-role", {
                        version: 1,
                        role: "compaction",
                        accept: (value: unknown) => {
                            after = value;
                        },
                    });
                    expect(after).toEqual({
                        status: "resolved",
                        model: { provider: "synthetic", modelId: "compact" },
                    });
                } finally {
                    try {
                        await session.extensionRunner.emit({
                            type: "session_shutdown",
                            reason: "quit",
                        });
                    } finally {
                        session.dispose();
                    }
                }
            } finally {
                if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
                else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
        },
    );

    it("preserves host prompt snippets across preset activation without narrowing later activation", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-toggles-tool-snippets-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "project");
        const agentDir = join(root, "agent");
        await mkdir(cwd, { recursive: true });
        await mkdir(join(agentDir, "extension-settings"), { recursive: true });
        await writeFile(
            join(agentDir, "extension-settings", "pi-toggles.json"),
            JSON.stringify({
                profiles: {
                    focused: {
                        decisions: [{ target: { kind: "tool", name: "preset_tool" }, state: "on" }],
                        promptFragments: [],
                    },
                },
                rules: [
                    {
                        id: "focus",
                        priority: 0,
                        when: { fact: "prompt.text", contains: "focus" },
                        decisions: [],
                        activateProfiles: ["focused"],
                    },
                ],
            }),
        );
        const hostSnippets: Record<string, string>[] = [];
        const prepared: Array<{
            snippets: Record<string, string>;
            selectedTools: string[];
            prompt: string;
        }> = [];
        const requests: string[] = [];
        const errors: string[] = [];
        const modelRuntime = await syntheticRuntime(requests);
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        try {
            const loader = await createLoader(cwd, agentDir, true, [
                {
                    name: "snippet-tools",
                    factory(pi) {
                        pi.registerTool({
                            name: "concise_tool",
                            label: "Concise",
                            description: "Full verbose concise_tool description",
                            promptSnippet: "Concise host snippet",
                            parameters: Type.Object({}),
                            async execute() {
                                return {
                                    content: [{ type: "text", text: "done" }],
                                    details: undefined,
                                };
                            },
                        });
                        pi.registerTool({
                            name: "unsnippeted_tool",
                            label: "Unsnippeted",
                            description: "Full unsnippeted_tool description",
                            parameters: Type.Object({}),
                            async execute() {
                                return {
                                    content: [{ type: "text", text: "done" }],
                                    details: undefined,
                                };
                            },
                        });
                        for (const name of ["preset_tool", "later_tool"]) {
                            pi.registerTool({
                                name,
                                label: name,
                                description: `Full verbose ${name} description`,
                                promptSnippet: `${name} host snippet`,
                                exposure: "deferred",
                                parameters: Type.Object({}),
                                async execute() {
                                    return {
                                        content: [{ type: "text", text: "done" }],
                                        details: undefined,
                                    };
                                },
                            });
                        }
                        pi.on("before_agent_start", (event) => {
                            hostSnippets.push({ ...event.systemPromptOptions.toolSnippets });
                        });
                    },
                },
                { name: "toggles", factory: extension },
                {
                    name: "snippet-observer",
                    factory(pi) {
                        pi.on("before_agent_start", (event) => {
                            prepared.push({
                                snippets: { ...event.systemPromptOptions.toolSnippets },
                                selectedTools: [...event.systemPromptOptions.selectedTools],
                                prompt: event.systemPrompt,
                            });
                        });
                    },
                },
            ]);
            const model = modelRuntime.getModel("synthetic", "first");
            if (model === undefined) throw new Error("Synthetic model unavailable");
            const { session } = await createAgentSession({
                cwd,
                agentDir,
                modelRuntime,
                model,
                resourceLoader: loader,
                sessionManager: SessionManager.inMemory(cwd),
                settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
            });
            await session.bindExtensions({
                mode: "print",
                onError: (error) => errors.push(error.error),
            });
            try {
                await session.prompt("ordinary task");
                await session.prompt("focus task");
                expect(errors).toEqual([]);
                expect(requests).toEqual(["first", "first"]);
                expect(prepared).toHaveLength(2);
                expect(hostSnippets).toHaveLength(2);
                for (const [index, turn] of prepared.entries()) {
                    expect(turn.snippets).toEqual(hostSnippets[index]);
                    expect(turn.snippets).toMatchObject({
                        concise_tool: "Concise host snippet",
                        preset_tool: "preset_tool host snippet",
                        later_tool: "later_tool host snippet",
                    });
                    expect(turn.snippets).not.toHaveProperty("unsnippeted_tool");
                    expect(turn.selectedTools).toContain("unsnippeted_tool");
                    expect(turn.selectedTools).not.toContain("later_tool");
                    expect(turn.prompt).toContain("- concise_tool: Concise host snippet");
                    expect(turn.prompt).not.toContain("- unsnippeted_tool:");
                    expect(turn.prompt).not.toContain("- later_tool:");
                    expect(turn.prompt).not.toContain("Full verbose");
                }
                expect(prepared[0]?.selectedTools).not.toContain("preset_tool");
                expect(prepared[0]?.prompt).not.toContain("- preset_tool:");
                expect(prepared[1]?.selectedTools).toContain("preset_tool");
                expect(prepared[1]?.prompt).toContain("- preset_tool: preset_tool host snippet");
            } finally {
                session.dispose();
            }
        } finally {
            if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        }
    });

    it("resolves dynamic presets and role references at agent starts while preserving a manual model choice", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-toggles-presets-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "project");
        const agentDir = join(root, "agent");
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        await mkdir(cwd, { recursive: true });
        await mkdir(join(agentDir, "extension-settings"), { recursive: true });
        await writeFile(
            join(agentDir, "extension-settings", "pi-toggles.json"),
            JSON.stringify({
                profiles: {
                    focused: {
                        decisions: [],
                        promptFragments: ["guide"],
                        modelRoles: {
                            main: { provider: "synthetic", modelId: "second" },
                            compaction: "@main",
                            review: "@review",
                            dangling: "@absent",
                        },
                    },
                },
                rules: [
                    {
                        id: "focus",
                        priority: 0,
                        when: { fact: "prompt.text", contains: "focus" },
                        decisions: [],
                        activateProfiles: ["focused"],
                    },
                ],
                promptFragments: [
                    {
                        id: "replacement",
                        priority: 0,
                        operation: "replace",
                        content: { kind: "inline", text: "Exact replacement" },
                        when: { fact: "preset.active", equals: "focused" },
                    },
                    {
                        id: "guide",
                        priority: 0,
                        content: { kind: "inline", text: "Owned guidance" },
                        when: { fact: "model.provider", equals: "synthetic" },
                    },
                ],
            }),
        );
        let api: ExtensionAPI | undefined;
        try {
            const modelRuntime = await ModelRuntime.create({
                credentials: new InMemoryCredentialStore(),
                modelsPath: null,
            });
            modelRuntime.registerProvider("synthetic", {
                api: "openai-completions",
                apiKey: "synthetic-key",
                baseUrl: "http://localhost",
                models: ["first", "second", "manual"].map((id) => ({
                    id,
                    name: id,
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 10000,
                    maxTokens: 100,
                })),
            });
            const model = modelRuntime.getModel("synthetic", "first");
            const manual = modelRuntime.getModel("synthetic", "manual");
            if (model === undefined || manual === undefined)
                throw new Error("Synthetic models unavailable");
            const loader = await createLoader(cwd, agentDir, true, [
                { name: "toggles", factory: extension },
                {
                    name: "role-consumer",
                    factory(pi) {
                        api = pi;
                    },
                },
            ]);
            const { session } = await createAgentSession({
                cwd,
                agentDir,
                modelRuntime,
                model,
                resourceLoader: loader,
                sessionManager: SessionManager.inMemory(cwd),
                settingsManager: SettingsManager.inMemory(),
            });
            await session.bindExtensions({ mode: "print" });
            try {
                const first = await session.extensionRunner.emitBeforeAgentStart(
                    { messageType: "user", prompt: "focus" },
                    { cwd },
                );
                expect(session.model?.id).toBe("second");
                expect(first.systemPromptOptions.forceSystemPrompt).toBe(
                    "Exact replacement\n\n## Pi Toggles: guide\n\nOwned guidance",
                );
                const plain = await session.extensionRunner.emitBeforeAgentStart(
                    { messageType: "user", prompt: "ordinary task" },
                    { cwd },
                );
                expect(plain.systemPromptOptions.forceSystemPrompt).not.toContain(
                    "Exact replacement",
                );
                expect(
                    plain.systemPromptOptions.forceSystemPrompt?.match(/Owned guidance/g),
                ).toHaveLength(1);
                await session.setModel(manual);
                await session.extensionRunner.emitBeforeAgentStart(
                    { messageType: "user", prompt: "focus" },
                    { cwd },
                );
                expect(session.model?.id).toBe("manual");
                if (api === undefined) throw new Error("Role consumer unavailable");
                let role: unknown;
                api.events.emit("pi-toggles:model-role", {
                    version: 1,
                    role: "compaction",
                    accept: (value: unknown) => {
                        role = value;
                    },
                });
                expect(role).toEqual({
                    status: "resolved",
                    model: { provider: "synthetic", modelId: "second" },
                });
                api.events.emit("pi-toggles:model-role", {
                    version: 1,
                    role: "review",
                    accept: (value: unknown) => {
                        role = value;
                    },
                });
                expect(role).toMatchObject({ status: "invalid" });
                api.events.emit("pi-toggles:model-role", {
                    version: 1,
                    role: "dangling",
                    accept: (value: unknown) => {
                        role = value;
                    },
                });
                expect(role).toMatchObject({ status: "invalid" });
                api.events.emit("pi-toggles:model-role", {
                    version: 1,
                    role: "absent",
                    accept: (value: unknown) => {
                        role = value;
                    },
                });
                expect(role).toMatchObject({ status: "missing" });
                await session.prompt("/toggles profile focused --scope session");
                expect(session.model?.id).toBe("manual");
                await session.extensionRunner.emitBeforeAgentStart(
                    { messageType: "user", prompt: "ordinary task" },
                    { cwd },
                );
                expect(session.model?.id).toBe("second");
            } finally {
                session.dispose();
            }
        } finally {
            if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        }
    });

    it.each(["toggles-first", "companion-first"] as const)(
        "accepts extension activation defaults with %s load order",
        async (loadOrder) => {
            const root = await mkdtemp(join(tmpdir(), "pi-toggles-coordination-"));
            temporaryDirectories.push(root);
            const cwd = join(root, "project");
            const agentDir = join(root, "agent");
            const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
            process.env.PI_CODING_AGENT_DIR = agentDir;
            const companion = createProposalExtension([
                { target: { kind: "tool", name: "write" }, state: "off" },
            ]);
            const togglesFactory = { name: "pi-toggles-test", factory: extension };
            const companionFactory = {
                name: "activation-companion-test",
                factory: companion.factory,
            };
            const extensionFactories =
                loadOrder === "toggles-first"
                    ? [togglesFactory, companionFactory]
                    : [companionFactory, togglesFactory];

            try {
                await mkdir(cwd, { recursive: true });
                const loader = await createLoader(cwd, agentDir, true, extensionFactories);
                const created = await createAgentSession({
                    cwd,
                    agentDir,
                    resourceLoader: loader,
                    sessionManager: SessionManager.inMemory(cwd),
                    settingsManager: SettingsManager.inMemory(),
                });
                await created.session.bindExtensions({ mode: "print" });
                try {
                    expect(
                        created.session.agent.state.tools.map((tool) => tool.name),
                    ).not.toContain("write");
                    expect(companion.acceptedSessions).toEqual([
                        created.session.sessionManager.getSessionId(),
                    ]);
                    companion.clearProposal(created.session.sessionManager.getSessionId());
                    await created.session.prompt("/toggles list tool");
                    expect(created.session.agent.state.tools.map((tool) => tool.name)).toContain(
                        "write",
                    );
                } finally {
                    created.session.dispose();
                }
            } finally {
                if (previousAgentDir === undefined) {
                    delete process.env.PI_CODING_AGENT_DIR;
                } else {
                    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
                }
            }
        },
    );

    it("lets explicit user policy override an extension activation default", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-toggles-coordination-override-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "project");
        const agentDir = join(root, "agent");
        const settingsDir = join(agentDir, "extension-settings");
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        await mkdir(settingsDir, { recursive: true });
        await writeFile(
            join(settingsDir, "pi-toggles.json"),
            `${JSON.stringify({
                enabled: true,
                overrides: [
                    {
                        target: { kind: "tool", source: "builtin", name: "write" },
                        state: "on",
                    },
                ],
            })}\n`,
            "utf8",
        );
        const companion = createProposalExtension([
            { target: { kind: "tool", name: "write" }, state: "off" },
        ]);

        try {
            await mkdir(cwd, { recursive: true });
            const loader = await createLoader(cwd, agentDir, true, [
                { name: "activation-companion-test", factory: companion.factory },
                { name: "pi-toggles-test", factory: extension },
            ]);
            const created = await createAgentSession({
                cwd,
                agentDir,
                resourceLoader: loader,
                sessionManager: SessionManager.inMemory(cwd),
                settingsManager: SettingsManager.inMemory(),
            });
            await created.session.bindExtensions({ mode: "print" });
            try {
                expect(created.session.agent.state.tools.map((tool) => tool.name)).toContain(
                    "write",
                );
            } finally {
                created.session.dispose();
            }
        } finally {
            if (previousAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
        }
    });

    it("does not claim activation ownership when Pi Toggles is disabled", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-toggles-coordination-disabled-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "project");
        const agentDir = join(root, "agent");
        const settingsDir = join(agentDir, "extension-settings");
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        await mkdir(settingsDir, { recursive: true });
        await writeFile(
            join(settingsDir, "pi-toggles.json"),
            `${JSON.stringify({ enabled: false })}\n`,
            "utf8",
        );
        const companion = createProposalExtension([
            { target: { kind: "tool", name: "write" }, state: "off" },
        ]);

        try {
            await mkdir(cwd, { recursive: true });
            const loader = await createLoader(cwd, agentDir, true, [
                { name: "pi-toggles-test", factory: extension },
                { name: "activation-companion-test", factory: companion.factory },
            ]);
            const created = await createAgentSession({
                cwd,
                agentDir,
                resourceLoader: loader,
                sessionManager: SessionManager.inMemory(cwd),
                settingsManager: SettingsManager.inMemory(),
            });
            await created.session.bindExtensions({ mode: "print" });
            try {
                expect(created.session.agent.state.tools.map((tool) => tool.name)).toContain(
                    "write",
                );
                expect(companion.acceptedSessions).toEqual([]);
            } finally {
                created.session.dispose();
            }
        } finally {
            if (previousAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
        }
    });

    it("removes a session-disabled tool and restores the decision when the saved session is reopened", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-toggles-integration-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "project");
        const agentDir = join(root, "agent");
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = agentDir;

        try {
            await mkdir(cwd, { recursive: true });
            const firstLoader = await createLoader(cwd, agentDir);
            const firstManager = SessionManager.create(cwd, join(root, "sessions"));
            firstManager.appendMessage({
                role: "user",
                content: "Existing session",
                timestamp: Date.now(),
            });
            firstManager.appendMessage({
                role: "assistant",
                content: [{ type: "text", text: "Ready" }],
                api: "openai-responses",
                provider: "openai",
                model: "test-model",
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: Date.now(),
            });
            const first = await createAgentSession({
                cwd,
                agentDir,
                resourceLoader: firstLoader,
                sessionManager: firstManager,
                settingsManager: SettingsManager.inMemory(),
            });
            await first.session.bindExtensions({ mode: "print" });
            const sessionFile = first.session.sessionFile;
            expect(sessionFile).toBeDefined();
            expect(first.session.agent.state.tools.map((tool) => tool.name)).toContain("write");

            await first.session.prompt("/toggles set write off --scope session");
            expect(first.session.agent.state.tools.map((tool) => tool.name)).not.toContain("write");
            expect(
                first.session.sessionManager
                    .getEntries()
                    .some(
                        (entry) =>
                            entry.type === "custom" && entry.customType === "pi-toggles-policy",
                    ),
            ).toBe(true);
            first.session.dispose();

            if (sessionFile === undefined) {
                throw new Error("Expected a persisted session file.");
            }
            const secondLoader = await createLoader(cwd, agentDir);
            const second = await createAgentSession({
                cwd,
                agentDir,
                resourceLoader: secondLoader,
                sessionManager: SessionManager.open(sessionFile, join(root, "sessions")),
                settingsManager: SettingsManager.inMemory(),
            });
            expect(
                second.session.sessionManager
                    .getEntries()
                    .some(
                        (entry) =>
                            entry.type === "custom" && entry.customType === "pi-toggles-policy",
                    ),
            ).toBe(true);
            await second.session.bindExtensions({ mode: "print" });
            try {
                expect(second.session.agent.state.tools.map((tool) => tool.name)).not.toContain(
                    "write",
                );
            } finally {
                second.session.dispose();
            }

            const newSessionLoader = await createLoader(cwd, agentDir);
            const newSession = await createAgentSession({
                cwd,
                agentDir,
                resourceLoader: newSessionLoader,
                sessionManager: SessionManager.inMemory(cwd),
                settingsManager: SettingsManager.inMemory(),
            });
            await newSession.session.bindExtensions({ mode: "print" });
            try {
                expect(newSession.session.agent.state.tools.map((tool) => tool.name)).toContain(
                    "write",
                );
            } finally {
                newSession.session.dispose();
            }
        } finally {
            if (previousAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
        }
    });

    it("keeps a lazy tool out of the initial set and activates it through capability search", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-toggles-lazy-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "project");
        const agentDir = join(root, "agent");
        const settingsDir = join(agentDir, "extension-settings");
        await mkdir(settingsDir, { recursive: true });
        await writeFile(
            join(settingsDir, "pi-toggles.json"),
            `${JSON.stringify(
                {
                    enabled: true,
                    overrides: [
                        {
                            target: { kind: "tool", source: "builtin", name: "write" },
                            state: "lazy",
                        },
                        {
                            target: { kind: "tool", source: "builtin", name: "ghost" },
                            state: "off",
                        },
                    ],
                },
                null,
                2,
            )}\n`,
            "utf8",
        );
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = agentDir;

        try {
            const loader = await createLoader(cwd, agentDir);
            const created = await createAgentSession({
                cwd,
                agentDir,
                resourceLoader: loader,
                sessionManager: SessionManager.inMemory(cwd),
                settingsManager: SettingsManager.inMemory(),
            });
            await created.session.bindExtensions({ mode: "print" });
            try {
                const initialNames = created.session.agent.state.tools.map((tool) => tool.name);
                expect(initialNames).not.toContain("write");
                expect(initialNames).toContain("search_capabilities");
                const search = created.session.agent.state.tools.find(
                    (tool) => tool.name === "search_capabilities",
                );
                if (search === undefined) {
                    throw new Error("Expected search_capabilities to be active.");
                }
                const result = await search.execute("search-1", { query: "write files" });
                expect(result.content).toContainEqual({
                    type: "text",
                    text: "Activated lazy tools: write",
                });
                expect(created.session.agent.state.tools.map((tool) => tool.name)).toContain(
                    "write",
                );

                await created.session.prompt("/toggles reset ghost --scope global");
                await created.session.prompt("/toggles set write off --scope global");
                expect(created.session.agent.state.tools.map((tool) => tool.name)).not.toContain(
                    "write",
                );
                const saved = await readFile(join(settingsDir, "pi-toggles.json"), "utf8");
                expect(saved.match(/"name": "write"/g)).toHaveLength(1);
                expect(saved).toContain('"state": "off"');
                expect(saved).not.toContain('"state": "lazy"');
                expect(saved).not.toContain('"name": "ghost"');

                await created.session.prompt("/toggles reset write --scope global");
                expect(created.session.agent.state.tools.map((tool) => tool.name)).toContain(
                    "write",
                );
            } finally {
                created.session.dispose();
            }
        } finally {
            if (previousAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
        }
    });

    it("filters skill metadata and blocks off skill expansion through real Pi hooks", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-toggles-skills-"));
        temporaryDirectories.push(root);
        const cwd = join(root, "project");
        const agentDir = join(root, "agent");
        await mkdir(join(agentDir, "skills", "review"), { recursive: true });
        await mkdir(cwd, { recursive: true });
        await writeFile(
            join(agentDir, "skills", "review", "SKILL.md"),
            "---\nname: review\ndescription: Review code carefully\n---\n\n# Review\n",
            "utf8",
        );
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = agentDir;

        try {
            const loader = await createLoader(cwd, agentDir, false);
            const skill = loader
                .getSkills()
                .skills.find((candidate) => candidate.name === "review");
            if (skill === undefined) {
                throw new Error("Expected review skill to be discovered.");
            }
            await mkdir(join(agentDir, "extension-settings"), { recursive: true });
            await writeFile(
                join(agentDir, "extension-settings", "pi-toggles.json"),
                `${JSON.stringify({
                    enabled: true,
                    overrides: [
                        {
                            target: {
                                kind: "skill",
                                source: skill.sourceInfo.source,
                                name: skill.name,
                            },
                            state: "off",
                        },
                    ],
                })}\n`,
                "utf8",
            );
            const created = await createAgentSession({
                cwd,
                agentDir,
                resourceLoader: loader,
                sessionManager: SessionManager.inMemory(cwd),
                settingsManager: SettingsManager.inMemory(),
            });
            await created.session.bindExtensions({ mode: "print" });
            try {
                const skills = loader.getSkills().skills;
                const before = await created.session.extensionRunner.emitBeforeAgentStart(
                    { messageType: "user", prompt: "Review this" },
                    { cwd, skills },
                );
                expect(before.systemPromptOptions.forceSystemPrompt).not.toContain(
                    "<name>review</name>",
                );
                expect(
                    await created.session.extensionRunner.emitInput(
                        "/skill:review focus on security",
                        undefined,
                        "interactive",
                    ),
                ).toEqual({ action: "handled" });

                await created.session.prompt("/toggles set review user-only --scope session");
                expect(
                    await created.session.extensionRunner.emitInput(
                        "/skill:review focus on security",
                        undefined,
                        "interactive",
                    ),
                ).toEqual({ action: "continue" });
                const userOnly = await created.session.extensionRunner.emitBeforeAgentStart(
                    { messageType: "user", prompt: "Review this" },
                    { cwd, skills },
                );
                expect(userOnly.systemPromptOptions.forceSystemPrompt).not.toContain(
                    "<name>review</name>",
                );
            } finally {
                created.session.dispose();
            }
        } finally {
            if (previousAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
        }
    });
});
