import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type {
    Api,
    AssistantMessage,
    FauxProviderRegistration,
    Model,
    TextContent,
} from "@earendil-works/pi-ai";
import {
    SessionManager,
    type ExtensionAPI,
    type ExtensionEvent,
    type SessionStartEvent,
    type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import extension from "../src/index.ts";
import { AUTONAME_STATE_ENTRY_TYPE, type SessionNamingState } from "../src/session-naming.ts";
import type { ExtensionSettingsDocument } from "../src/settings.ts";

const FAUX_API = "faux-test";
const FAUX_PROVIDER = "faux-provider";

type TestAuthResult =
    | {
          ok: true;
          apiKey?: string;
          headers?: Record<string, string>;
          env?: Record<string, string>;
      }
    | { ok: false; error: string };

class FakeModelRegistry {
    authCalls = 0;
    private authResult: TestAuthResult = { ok: true, apiKey: "test-key" };
    private authPromise: Promise<TestAuthResult> | undefined;
    private authenticationThrows = false;
    private availableModel: Model<Api> | undefined;

    constructor(model: Model<Api>) {
        this.availableModel = model;
    }

    setAuth(result: TestAuthResult): void {
        this.authResult = result;
        this.authPromise = undefined;
        this.authenticationThrows = false;
    }

    setPendingAuth(promise: Promise<TestAuthResult>): void {
        this.authPromise = promise;
        this.authenticationThrows = false;
    }

    setAuthenticationThrows(): void {
        this.authenticationThrows = true;
        this.authPromise = undefined;
    }

    setModelAvailable(model: Model<Api> | undefined): void {
        this.availableModel = model;
    }

    find(provider: string, modelId: string): Model<Api> | undefined {
        const model = this.availableModel;
        return model?.provider === provider && model?.id === modelId ? model : undefined;
    }

    async getApiKeyAndHeaders(): Promise<TestAuthResult> {
        this.authCalls += 1;
        if (this.authenticationThrows) {
            throw new Error("authentication resolver failed");
        }

        return this.authPromise ?? Promise.resolve(this.authResult);
    }
}

type TestUi = {
    notify(message: string, severity: "info" | "warning" | "error"): void;
};

/** The subset of ExtensionContext the extension reads. */
type TestContext = {
    ui: TestUi;
    hasUI: boolean;
    cwd: string;
    sessionManager: SessionManager;
    modelRegistry: FakeModelRegistry;
    model: Model<Api> | undefined;
    isProjectTrusted(): boolean;
};

type TestEvent = Extract<
    ExtensionEvent,
    {
        type:
            | "session_start"
            | "before_agent_start"
            | "agent_settled"
            | "session_shutdown"
            | "session_tree"
            | "model_select"
            | "session_info_changed";
    }
>;

type Handler = (event: TestEvent, ctx: TestContext) => void | Promise<void>;

/**
 * Recording stand-in for the ExtensionAPI. Mirrors the real pi surface the
 * extension uses. Session-name state changes are synchronous, while their
 * session_info_changed notifications remain queued until flushEvents(),
 * matching Pi's fire-and-forget event dispatch interval.
 */
class FakePi {
    readonly handlers = new Map<string, Handler>();
    readonly appended: { customType: string; data: SessionNamingState }[] = [];
    readonly notified: { message: string; severity: "info" | "warning" | "error" }[] = [];

    readonly execCalls: { command: string; args: readonly string[]; cwd: string | undefined }[] =
        [];

    sessionName: string | undefined = undefined;
    sessionNameError: Error | undefined;
    readonly sessionNameCalls: string[] = [];
    lastCtx: TestContext | undefined;
    gitStatus = "## main\n";
    private readonly pendingEvents: TestEvent[] = [];

    on(event: string, handler: Handler): void {
        this.handlers.set(event, handler);
    }

    appendEntry(customType: string, data: SessionNamingState): void {
        this.appended.push({ customType, data });
        this.lastCtx?.sessionManager.appendCustomEntry(customType, data);
    }

    setSessionName(name: string): void {
        this.sessionNameCalls.push(name);

        if (this.sessionNameError !== undefined) {
            throw this.sessionNameError;
        }

        this.sessionName = name;
        if (this.lastCtx !== undefined) {
            this.lastCtx.sessionManager.appendSessionInfo(name);
            this.pendingEvents.push({ type: "session_info_changed", name });
        }
    }

    getSessionName(): string | undefined {
        return this.sessionName;
    }

    async exec(
        command: string,
        args: string[],
        options?: { readonly cwd?: string },
    ): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
        this.execCalls.push({ command, args, cwd: options?.cwd });
        return Promise.resolve({ stdout: this.gitStatus, stderr: "", code: 0, killed: false });
    }

    async emit(event: TestEvent, ctx: TestContext): Promise<void> {
        this.lastCtx = ctx;
        const handler = this.handlers.get(event.type);
        if (handler !== undefined) {
            await handler(event, ctx);
        }
    }

    async flushEvents(): Promise<void> {
        while (this.pendingEvents.length > 0) {
            const event = this.pendingEvents.shift();
            if (event !== undefined && this.lastCtx !== undefined) {
                await this.emit(event, this.lastCtx);
            }
        }
    }
}

class Harness {
    private constructor(
        readonly agentDir: string,
        readonly faux: FauxProviderRegistration,
        readonly model: Model<Api>,
        readonly registry: FakeModelRegistry,
        readonly pi: FakePi,
        public ctx: TestContext,
        private readonly previousAgentDir: string | undefined,
    ) {}

    get session(): SessionManager {
        return this.ctx.sessionManager;
    }

    static create(): Harness {
        const agentDir = mkdtempSync(join(tmpdir(), "pi-autoname-session-test-"));
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const faux = registerFauxProvider({ api: FAUX_API, provider: FAUX_PROVIDER });

        // The extension only reads this subset of ExtensionAPI; the harness
        // implements exactly those members (on, appendEntry, setSessionName,
        // getSessionName, and exec), which is why the full interface is asserted away.
        // SAFETY: extension() registers handlers and reads session state
        // exclusively through these members, so the narrower fake is
        // behaviorally complete for every path under test.
        const pi = new FakePi();
        const model = faux.getModel();
        const registry = new FakeModelRegistry(model);
        const session = SessionManager.inMemory("/workspace/project");
        const ctx: TestContext = {
            ui: {
                notify: (message, severity) => {
                    pi.notified.push({ message, severity });
                },
            },
            hasUI: true,
            cwd: "/workspace/project",
            sessionManager: session,
            modelRegistry: registry,
            model,
            isProjectTrusted: () => false,
        };

        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the harness implements the on, appendEntry, setSessionName, getSessionName, and exec operations read by the extension factory, and these tests exercise every registered event through that adapter; TypeScript cannot express a callable subset of ExtensionAPI where on retains its event-specific callback types.
        extension(pi as ExtensionAPI & FakePi);
        const harness = new Harness(agentDir, faux, model, registry, pi, ctx, previousAgentDir);
        pi.lastCtx = ctx;
        return harness;
    }

    dispose(): void {
        this.faux.unregister();
        rmSync(this.agentDir, { recursive: true, force: true });

        if (process.env.PI_CODING_AGENT_DIR === this.agentDir) {
            if (this.previousAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = this.previousAgentDir;
            }
        }
    }

    async startSession(reason: SessionStartEvent["reason"] = "startup"): Promise<void> {
        this.pi.sessionName = this.session.getSessionName();
        return this.pi.emit({ type: "session_start", reason }, this.ctx);
    }

    async replaceSession(session: SessionManager): Promise<void> {
        this.ctx = { ...this.ctx, sessionManager: session };
        await this.startSession("new");
    }

    async beforeAgentStart(prompt: string): Promise<void> {
        return this.pi.emit(
            {
                type: "before_agent_start",
                prompt,
                systemPrompt: "",
                systemPromptOptions: { cwd: this.ctx.cwd, contextFiles: [] },
            },
            this.ctx,
        );
    }

    async settled(): Promise<void> {
        return this.pi.emit({ type: "agent_settled" }, this.ctx);
    }

    rename(name: string): void {
        this.pi.setSessionName(name);
    }

    async flushEvents(): Promise<void> {
        return this.pi.flushEvents();
    }

    async navigateTree(newLeafId: string | null, oldLeafId: string | null): Promise<void> {
        return this.pi.emit({ type: "session_tree", newLeafId, oldLeafId }, this.ctx);
    }

    async shutdown(reason: SessionShutdownEvent["reason"] = "quit"): Promise<void> {
        return this.pi.emit({ type: "session_shutdown", reason }, this.ctx);
    }

    async modelSelect(): Promise<void> {
        return this.pi.emit(
            { type: "model_select", model: this.model, previousModel: undefined, source: "set" },
            this.ctx,
        );
    }
}

function createSettings(
    overrides: Partial<ExtensionSettingsDocument> = {},
): ExtensionSettingsDocument {
    return {
        enabled: true,
        initialNaming: { enabled: true, timing: "prompt", trigger: "messages", threshold: 1 },
        refreshNaming: { enabled: false, trigger: "turns", threshold: 10 },
        model: "current",
        reasoningEffort: "low",
        timeoutMs: 5_000,
        conversationScope: "minimized",
        prompt: "Name the session. {{conversation}}",
        nameConstraints: { minLength: 6, maxLength: 60 },
        ...overrides,
    };
}

type TestSettingsDocument =
    | ExtensionSettingsDocument
    | (Omit<ExtensionSettingsDocument, "initialNaming"> & {
          readonly initialNaming: Omit<ExtensionSettingsDocument["initialNaming"], "timing">;
      });

function settingsPath(harness: Harness): string {
    return join(harness.agentDir, "extension-settings", "pi-autoname-session.json");
}

function writeSettingsBytes(harness: Harness, contents: string): void {
    mkdirSync(join(harness.agentDir, "extension-settings"), { recursive: true });
    writeFileSync(settingsPath(harness), contents, "utf8");
}

function writeSettings(harness: Harness, settings: TestSettingsDocument): void {
    writeSettingsBytes(harness, JSON.stringify(settings));
}

function appendUserMessage(session: SessionManager, content: string, timestamp: number): void {
    session.appendMessage({ role: "user", content, timestamp });
}

function appendAssistantTurn(session: SessionManager, text: string, timestamp: number): string {
    return session.appendMessage({
        role: "assistant",
        content: [{ type: "text", text }],
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
        stopReason: "stop",
        timestamp,
    });
}

type Deferred<T> = {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
    readonly reject: (cause: Error) => void;
};

function createDeferred<T>(): Deferred<T> {
    let resolve: (value: T) => void = () => {};
    let reject: (cause: Error) => void = () => {};
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return { promise, resolve, reject };
}

function stateEntries(harness: Harness): SessionNamingState[] {
    return harness.pi.appended
        .filter((entry) => entry.customType === AUTONAME_STATE_ENTRY_TYPE)
        .map((entry) => entry.data);
}

function latestState(harness: Harness): SessionNamingState | undefined {
    return stateEntries(harness).at(-1);
}

function allDiagnostics(harness: Harness): string {
    return harness.pi.notified.map((notification) => notification.message).join(" ");
}

describe("extension orchestration", () => {
    describe.each([
        {
            label: "malformed JSON",
            contents: '{"enabled": true, "prompt": "SECRET-SETTINGS",\n',
            diagnostic: true,
        },
        {
            label: "schema-invalid enabled",
            contents: '{\n  "enabled": "SECRET-SETTINGS"\n}\n',
            diagnostic: true,
        },
        {
            label: "explicitly disabled naming",
            contents: JSON.stringify(createSettings({ enabled: false }), null, 2) + "\n",
            diagnostic: false,
        },
        {
            label: "contradictory name constraints",
            contents:
                JSON.stringify(
                    createSettings({ nameConstraints: { minLength: 60, maxLength: 6 } }),
                    null,
                    2,
                ) + "\n",
            diagnostic: true,
        },
    ])("$label", ({ contents, diagnostic }) => {
        it.each([true, false])(
            "disables naming without rewriting settings (hasUI=%s)",
            async (hasUI) => {
                const harness = Harness.create();
                try {
                    harness.ctx.hasUI = hasUI;
                    writeSettingsBytes(harness, contents);
                    const original = readFileSync(settingsPath(harness));
                    harness.faux.setResponses([fauxAssistantMessage("Should never be requested")]);
                    await harness.startSession();
                    const diagnostics = [...harness.pi.notified];
                    expect(diagnostics).toHaveLength(diagnostic && hasUI ? 1 : 0);

                    if (diagnostic && hasUI) {
                        expect(diagnostics[0]?.severity).toBe("error");
                    }

                    for (const prompt of ["Fix the parser", "Explain parser recovery"]) {
                        await harness.beforeAgentStart(prompt);
                        appendUserMessage(harness.session, prompt, 1);
                        await harness.settled();
                    }

                    await harness.shutdown();
                    expect(harness.registry.authCalls).toBe(0);
                    expect(harness.faux.state.callCount).toBe(0);
                    expect(harness.pi.sessionNameCalls).toEqual([]);
                    expect(harness.session.getSessionName()).toBeUndefined();
                    expect(stateEntries(harness)).toEqual([]);
                    expect(harness.pi.notified).toEqual(diagnostics);
                    expect(allDiagnostics(harness)).not.toContain("SECRET-SETTINGS");
                    expect(readFileSync(settingsPath(harness))).toEqual(original);
                } finally {
                    await harness.shutdown();
                    harness.dispose();
                }
            },
        );
    });

    it("loads settings only on activation and retries repaired settings on the next session", async () => {
        const harness = Harness.create();
        try {
            expect(existsSync(join(harness.agentDir, "extension-settings"))).toBe(false);
            await harness.beforeAgentStart("Prompt before activation");
            await harness.settled();
            expect(existsSync(join(harness.agentDir, "extension-settings"))).toBe(false);
            expect(harness.registry.authCalls).toBe(0);

            writeSettingsBytes(harness, "{broken");
            await harness.startSession();
            expect(harness.pi.notified).toHaveLength(1);
            writeSettings(harness, createSettings());
            harness.faux.setResponses([fauxAssistantMessage("Repaired settings name")]);

            await harness.beforeAgentStart("Fix the parser");
            appendUserMessage(harness.session, "Fix the parser", 1);
            await harness.settled();
            expect(harness.faux.state.callCount).toBe(0);
            expect(harness.pi.sessionNameCalls).toEqual([]);
            expect(harness.pi.notified).toHaveLength(1);

            await harness.shutdown("reload");
            await harness.startSession("reload");
            await harness.settled();
            expect(harness.faux.state.callCount).toBe(1);
            expect(harness.pi.sessionName).toBe("Repaired settings name");
            expect(harness.pi.notified).toHaveLength(1);
        } finally {
            await harness.shutdown();
            harness.dispose();
        }
    });

    it("keeps valid settings usable when the editor schema cannot be installed", async () => {
        const harness = Harness.create();
        try {
            writeSettings(harness, createSettings());
            const original = readFileSync(settingsPath(harness));

            const schemaDirectory = join(harness.agentDir, "extension-settings", "schemas");
            writeFileSync(schemaDirectory, "do not replace\n", "utf8");
            await harness.startSession();
            expect(allDiagnostics(harness)).toContain("editor schema could not be installed");
            expect(harness.pi.notified).toHaveLength(1);

            harness.faux.setResponses([fauxAssistantMessage("Valid settings name")]);
            appendUserMessage(harness.session, "Fix the parser", 1);
            await harness.settled();
            expect(harness.faux.state.callCount).toBe(1);
            expect(harness.pi.sessionName).toBe("Valid settings name");
            expect(readFileSync(settingsPath(harness))).toEqual(original);
            expect(readFileSync(schemaDirectory, "utf8")).toBe("do not replace\n");
        } finally {
            await harness.shutdown();
            harness.dispose();
        }
    });

    it("names an unnamed session without blocking prompt submission", async () => {
        const harness = Harness.create();
        try {
            writeSettings(
                harness,
                createSettings({
                    initialNaming: {
                        enabled: true,
                        timing: "prompt",
                        trigger: "messages",
                        threshold: 1,
                    },
                }),
            );
            await harness.startSession();
            let capturedPrompt = "";
            const response = createDeferred<AssistantMessage>();
            harness.faux.setResponses([
                async (context) => {
                    const content = context.messages[0]?.content;
                    const textBlock = Array.isArray(content)
                        ? content.find((block): block is TextContent => block.type === "text")
                        : undefined;
                    capturedPrompt = textBlock?.text ?? "";
                    return response.promise;
                },
            ]);

            await harness.beforeAgentStart("Fix the parser");

            expect(harness.pi.sessionName).toBeUndefined();
            expect(stateEntries(harness)).toHaveLength(0);
            await expect.poll(() => harness.faux.state.callCount).toBe(1);
            expect(capturedPrompt).toContain("USER:\nFix the parser");

            // Pi appends the submitted message while background naming is in flight.
            // Normal descendant progress must not make the picker result stale.
            appendUserMessage(harness.session, "Fix the parser", 1);
            response.resolve(fauxAssistantMessage("Fix parser tests"));
            await expect.poll(() => harness.pi.sessionName).toBe("Fix parser tests");
            expect(latestState(harness)).toEqual(expect.objectContaining({ initialNameSet: true }));

            await harness.settled();
            expect(harness.faux.state.callCount).toBe(1);
        } finally {
            harness.dispose();
        }
    });

    it("adds changed areas only when the first prompt is opaque", async () => {
        const harness = Harness.create();
        try {
            writeSettings(
                harness,
                createSettings({
                    prompt: "{{repository_context}}\n\n{{conversation}}",
                }),
            );
            harness.pi.gitStatus =
                "## feature/naming...origin/feature/naming\n M packages/pi-model-filter/src/index.ts\n M packages/pi-model-filter/test.ts\n M README.md\n";
            await harness.startSession();
            let capturedPrompt = "";
            harness.faux.setResponses([
                (context) => {
                    const content = context.messages[0]?.content;
                    const textBlock = Array.isArray(content)
                        ? content.find((block): block is TextContent => block.type === "text")
                        : undefined;
                    capturedPrompt = textBlock?.text ?? "";
                    return fauxAssistantMessage("Update model filtering");
                },
            ]);

            await harness.beforeAgentStart("$commit");

            await expect.poll(() => harness.pi.sessionName).toBe("Update model filtering");
            expect(harness.pi.execCalls).toHaveLength(1);
            expect(capturedPrompt).toContain("Branch: feature/naming");
            expect(capturedPrompt).toContain("- packages/pi-model-filter");
            expect(capturedPrompt).toContain("- README.md");
            expect(capturedPrompt).toContain("USER:\n$commit");
        } finally {
            harness.dispose();
        }
    });

    it("does not inspect git for a descriptive first prompt", async () => {
        const harness = Harness.create();
        try {
            writeSettings(harness, createSettings());
            await harness.startSession();
            harness.faux.setResponses([fauxAssistantMessage("Fix parser recovery")]);

            await harness.beforeAgentStart("Fix parser recovery after malformed input");

            await expect.poll(() => harness.pi.sessionName).toBe("Fix parser recovery");
            expect(harness.pi.execCalls).toHaveLength(0);
        } finally {
            harness.dispose();
        }
    });

    it("defaults existing settings without timing to prompt naming", async () => {
        const harness = Harness.create();
        try {
            const settings = createSettings();
            writeSettings(harness, {
                ...settings,
                initialNaming: { enabled: true, trigger: "messages", threshold: 1 },
            });
            await harness.startSession();
            harness.faux.setResponses([fauxAssistantMessage("Fix parser tests")]);

            await harness.beforeAgentStart("Fix the parser");

            await expect.poll(() => harness.faux.state.callCount).toBe(1);
            await expect.poll(() => harness.pi.sessionName).toBe("Fix parser tests");
        } finally {
            harness.dispose();
        }
    });

    it("waits for the agent to settle when settled timing is configured", async () => {
        const harness = Harness.create();
        try {
            writeSettings(
                harness,
                createSettings({
                    initialNaming: {
                        enabled: true,
                        timing: "settled",
                        trigger: "messages",
                        threshold: 1,
                    },
                }),
            );
            await harness.startSession();
            await harness.beforeAgentStart("Fix the parser");
            expect(harness.faux.state.callCount).toBe(0);
            expect(harness.pi.sessionName).toBeUndefined();

            appendUserMessage(harness.session, "Fix the parser", 1);
            harness.faux.setResponses([fauxAssistantMessage("Fix parser tests")]);
            await harness.settled();

            expect(harness.faux.state.callCount).toBe(1);
            expect(harness.pi.sessionName).toBe("Fix parser tests");
        } finally {
            harness.dispose();
        }
    });

    it("falls back to the settled checkpoint for post-prompt activity triggers", async () => {
        const harness = Harness.create();
        try {
            writeSettings(
                harness,
                createSettings({
                    initialNaming: {
                        enabled: true,
                        timing: "prompt",
                        trigger: "turns",
                        threshold: 1,
                    },
                }),
            );
            await harness.startSession();
            await harness.beforeAgentStart("Fix the parser");
            expect(harness.faux.state.callCount).toBe(0);

            appendUserMessage(harness.session, "Fix the parser", 1);
            appendAssistantTurn(harness.session, "I will fix it", 2);
            harness.faux.setResponses([fauxAssistantMessage("Fix parser tests")]);
            await harness.settled();

            expect(harness.faux.state.callCount).toBe(1);
            expect(harness.pi.sessionName).toBe("Fix parser tests");
        } finally {
            harness.dispose();
        }
    });

    it("names an unnamed session after the initial trigger", async () => {
        const harness = Harness.create();
        try {
            writeSettings(harness, createSettings());
            await harness.startSession();
            appendUserMessage(harness.session, "Fix the parser", 1);
            harness.faux.setResponses([fauxAssistantMessage("Fix parser tests")]);

            await harness.settled();

            expect(harness.pi.sessionName).toBe("Fix parser tests");
            expect(harness.faux.state.callCount).toBe(1);
            expect(latestState(harness)).toEqual(expect.objectContaining({ initialNameSet: true }));
        } finally {
            harness.dispose();
        }
    });

    it("discards a stale picker result after a manual rename", async () => {
        const harness = Harness.create();
        try {
            writeSettings(harness, createSettings());
            await harness.startSession();
            appendUserMessage(harness.session, "Fix the parser", 1);

            const deferred = createDeferred<AssistantMessage>();
            harness.faux.setResponses([async () => deferred.promise]);
            const settled = harness.settled();

            // The user renames while the picker request is in flight.
            harness.rename("user chosen name");
            deferred.resolve(fauxAssistantMessage("model picked name"));
            await settled;

            expect(harness.pi.sessionName).toBe("user chosen name");
            expect(harness.faux.state.callCount).toBe(1);
            expect(allDiagnostics(harness)).toBe("");

            await harness.flushEvents();
            expect(latestState(harness)).toEqual(expect.objectContaining({ initialNameSet: true }));
        } finally {
            harness.dispose();
        }
    });

    it("aborts the provider request when a manual rename event invalidates the attempt", async () => {
        const harness = Harness.create();
        try {
            writeSettings(harness, createSettings());
            await harness.startSession();
            appendUserMessage(harness.session, "Fix the parser", 1);

            const requestStarted = createDeferred<void>();
            let requestWasAborted = false;
            harness.faux.setResponses([
                async (context, options) =>
                    new Promise<AssistantMessage>((resolve) => {
                        requestStarted.resolve(undefined);
                        options?.signal?.addEventListener(
                            "abort",
                            () => {
                                requestWasAborted = true;
                                resolve(fauxAssistantMessage("late name"));
                            },
                            { once: true },
                        );
                    }),
            ]);

            const settled = harness.settled();
            await requestStarted.promise;
            harness.rename("user chosen name");
            await harness.flushEvents();
            await settled;

            expect(requestWasAborted).toBe(true);
            expect(harness.pi.sessionName).toBe("user chosen name");
            expect(allDiagnostics(harness)).toBe("");
        } finally {
            harness.dispose();
        }
    });

    it("discards stale failures and diagnostics before a delayed rename event arrives", async () => {
        const harness = Harness.create();
        try {
            writeSettings(harness, createSettings());
            await harness.startSession();
            appendUserMessage(harness.session, "Fix the parser", 1);

            const deferred = createDeferred<AssistantMessage>();
            harness.faux.setResponses([async () => deferred.promise]);
            const settled = harness.settled();
            harness.rename("user chosen name");
            deferred.resolve(
                fauxAssistantMessage("ignored", {
                    stopReason: "error",
                    errorMessage: "stale provider failure",
                }),
            );
            await settled;

            expect(allDiagnostics(harness)).toBe("");
            expect(stateEntries(harness)).toHaveLength(0);

            await harness.flushEvents();
            expect(stateEntries(harness)).toHaveLength(1);
        } finally {
            harness.dispose();
        }
    });

    it("compares the actual active leaf before a delayed tree event arrives", async () => {
        const harness = Harness.create();
        try {
            writeSettings(harness, createSettings());
            await harness.startSession();
            appendUserMessage(harness.session, "Old branch work", 1);

            const deferred = createDeferred<AssistantMessage>();
            harness.faux.setResponses([async () => deferred.promise]);
            const settled = harness.settled();
            const oldLeafId = harness.session.getLeafId();
            harness.session.resetLeaf();
            deferred.resolve(fauxAssistantMessage("stale branch name"));
            await settled;

            expect(harness.pi.sessionName).toBeUndefined();
            expect(stateEntries(harness)).toHaveLength(0);
            expect(allDiagnostics(harness)).toBe("");

            await harness.navigateTree(harness.session.getLeafId(), oldLeafId);
            expect(stateEntries(harness)).toHaveLength(1);
        } finally {
            harness.dispose();
        }
    });

    it("aborts the provider request when tree navigation invalidates the attempt", async () => {
        const harness = Harness.create();
        try {
            writeSettings(harness, createSettings());
            await harness.startSession();
            appendUserMessage(harness.session, "Old branch work", 1);

            const requestStarted = createDeferred<void>();
            let requestWasAborted = false;
            harness.faux.setResponses([
                async (context, options) =>
                    new Promise<AssistantMessage>((resolve) => {
                        requestStarted.resolve(undefined);
                        options?.signal?.addEventListener(
                            "abort",
                            () => {
                                requestWasAborted = true;
                                resolve(fauxAssistantMessage("stale branch name"));
                            },
                            { once: true },
                        );
                    }),
            ]);
            const settled = harness.settled();
            await requestStarted.promise;

            const oldLeafId = harness.session.getLeafId();
            harness.session.resetLeaf();
            await harness.navigateTree(harness.session.getLeafId(), oldLeafId);
            await settled;

            expect(requestWasAborted).toBe(true);
            expect(harness.pi.sessionName).toBeUndefined();
            expect(stateEntries(harness)).toHaveLength(1);
            expect(allDiagnostics(harness)).toBe("");
        } finally {
            harness.dispose();
        }
    });

    it.each(["resolve", "reject"])(
        "isolates a replacement session while the old picker request finishes (%s)",
        async (completion) => {
            const harness = Harness.create();
            const oldResponse = createDeferred<AssistantMessage>();
            const replacementResponse = createDeferred<AssistantMessage>();
            let replacementNaming: Promise<void> | undefined;
            try {
                writeSettings(
                    harness,
                    createSettings({
                        refreshNaming: { enabled: true, trigger: "turns", threshold: 2 },
                    }),
                );
                await harness.startSession();
                const oldRequestStarted = createDeferred<void>();
                const replacementRequestStarted = createDeferred<void>();
                let oldSignal: AbortSignal | undefined;
                harness.faux.setResponses([
                    async (_context, options) => {
                        oldSignal = options?.signal;
                        oldRequestStarted.resolve(undefined);
                        return oldResponse.promise;
                    },
                    async () => {
                        replacementRequestStarted.resolve(undefined);
                        return replacementResponse.promise;
                    },
                ]);
                await harness.beforeAgentStart("Old parser work");
                await oldRequestStarted.promise;
                const oldSession = harness.session;

                const replacement = SessionManager.inMemory(harness.ctx.cwd);
                appendUserMessage(replacement, "Replacement parser work", 1);
                replacement.appendCustomEntry(AUTONAME_STATE_ENTRY_TYPE, {
                    version: 1,
                    initialNameSet: true,
                    baseline: { messages: 1, turns: 0, toolCalls: 0, tokens: 0 },
                    baselineAtMs: 0,
                });
                appendAssistantTurn(replacement, "First replacement turn", 2);
                replacement.appendSessionInfo("Replacement session");
                await harness.replaceSession(replacement);
                expect(oldSignal?.aborted).toBe(true);

                await harness.settled();
                expect(harness.faux.state.callCount).toBe(1);
                appendAssistantTurn(replacement, "Second replacement turn", 3);
                const replacementBranch = replacement.getBranch();
                replacementNaming = harness.settled();
                await replacementRequestStarted.promise;

                if (completion === "resolve") {
                    oldResponse.resolve(fauxAssistantMessage("Stale predecessor name"));
                } else {
                    oldResponse.reject(new Error("SECRET-PREDECESSOR-FAILURE"));
                }

                await setImmediate();
                expect(harness.pi.sessionName).toBe("Replacement session");
                expect(replacement.getBranch()).toEqual(replacementBranch);
                expect(oldSession.getSessionName()).toBeUndefined();
                expect(stateEntries(harness)).toEqual([]);
                expect(harness.pi.notified).toEqual([]);

                await harness.settled();
                expect(harness.faux.state.callCount).toBe(2);

                replacementResponse.resolve(fauxAssistantMessage("Replacement refreshed name"));
                await replacementNaming;
                await harness.flushEvents();
                expect(harness.pi.sessionName).toBe("Replacement refreshed name");
                expect(stateEntries(harness)).toHaveLength(1);
                expect(latestState(harness)?.baseline).toEqual({
                    messages: 1,
                    turns: 2,
                    toolCalls: 0,
                    tokens: 20,
                });
                await harness.settled();
                expect(harness.faux.state.callCount).toBe(2);

                appendAssistantTurn(replacement, "Third replacement turn", 4);
                appendAssistantTurn(replacement, "Fourth replacement turn", 5);
                harness.faux.setResponses([fauxAssistantMessage("short")]);
                await harness.settled();
                expect(harness.faux.state.callCount).toBe(3);
                expect(allDiagnostics(harness)).toContain("unusable name");
                expect(harness.pi.notified).toHaveLength(1);
                expect(allDiagnostics(harness)).not.toContain("SECRET-PREDECESSOR-FAILURE");
                expect(harness.pi.sessionName).toBe("Replacement refreshed name");
                expect(stateEntries(harness)).toHaveLength(1);
            } finally {
                oldResponse.resolve(fauxAssistantMessage("Cleanup predecessor"));
                replacementResponse.resolve(fauxAssistantMessage("Cleanup replacement"));
                await replacementNaming;
                await harness.shutdown();
                harness.dispose();
            }
        },
    );

    it("rebases naming state when navigating the session tree", async () => {
        const harness = Harness.create();
        try {
            writeSettings(
                harness,
                createSettings({
                    refreshNaming: { enabled: true, trigger: "turns", threshold: 2 },
                }),
            );

            // A named session whose stored state carries a large old-branch baseline.
            harness.session.appendMessage({
                role: "user",
                content: "Old branch work",
                timestamp: 1,
            });
            harness.session.appendCustomEntry(AUTONAME_STATE_ENTRY_TYPE, {
                version: 1,
                initialNameSet: true,
                baseline: { messages: 1, turns: 100, toolCalls: 0, tokens: 0 },
                baselineAtMs: 0,
            });
            harness.session.appendSessionInfo("Manual name");
            await harness.startSession();

            // Navigate to the session root: the extension rebases onto the new branch.
            const oldLeafId = harness.session.getLeafId();
            harness.session.resetLeaf();
            await harness.navigateTree(harness.session.getLeafId(), oldLeafId);

            // Three turns on the new branch reach the refresh threshold only
            // against the rebased baseline.
            appendUserMessage(harness.session, "New branch work", 2);
            appendAssistantTurn(harness.session, "Step 1", 3);
            appendAssistantTurn(harness.session, "Step 2", 4);
            appendAssistantTurn(harness.session, "Step 3", 5);
            harness.faux.setResponses([fauxAssistantMessage("Rebased name")]);

            await harness.settled();

            expect(harness.faux.state.callCount).toBe(1);
            expect(harness.pi.sessionName).toBe("Rebased name");
        } finally {
            harness.dispose();
        }
    });

    it("restores naming state from the active branch only", async () => {
        const harness = Harness.create();
        try {
            writeSettings(harness, createSettings());
            harness.session.appendMessage({
                role: "user",
                content: "Old branch work",
                timestamp: 1,
            });
            harness.session.appendCustomEntry(AUTONAME_STATE_ENTRY_TYPE, {
                version: 1,
                initialNameSet: true,
                baseline: { messages: 10, turns: 10, toolCalls: 0, tokens: 0 },
                baselineAtMs: 0,
            });

            // Navigate away: the stored state is no longer on the active branch.
            harness.session.resetLeaf();
            appendUserMessage(harness.session, "New branch work", 2);
            await harness.startSession();

            harness.faux.setResponses([fauxAssistantMessage("New branch name")]);
            await harness.settled();

            // The abandoned-branch state must not suppress initial naming.
            expect(harness.faux.state.callCount).toBe(1);
            expect(harness.pi.sessionName).toBe("New branch name");
        } finally {
            harness.dispose();
        }
    });

    it("restores the target branch's stored baseline after tree navigation", async () => {
        const harness = Harness.create();
        try {
            writeSettings(
                harness,
                createSettings({
                    refreshNaming: { enabled: true, trigger: "turns", threshold: 2 },
                }),
            );

            appendUserMessage(harness.session, "Root work", 1);
            harness.session.appendCustomEntry(AUTONAME_STATE_ENTRY_TYPE, {
                version: 1,
                initialNameSet: true,
                baseline: { messages: 1, turns: 0, toolCalls: 0, tokens: 0 },
                baselineAtMs: 0,
            });
            appendAssistantTurn(harness.session, "First turn", 2);
            const namedBranchLeaf = harness.session.appendSessionInfo("Stored branch name");
            await harness.startSession();

            const oldLeafId = harness.session.getLeafId();
            harness.session.resetLeaf();
            appendUserMessage(harness.session, "Other root", 3);
            await harness.navigateTree(harness.session.getLeafId(), oldLeafId);

            const otherLeafId = harness.session.getLeafId();
            harness.session.branch(namedBranchLeaf);
            await harness.navigateTree(harness.session.getLeafId(), otherLeafId);

            appendAssistantTurn(harness.session, "Second turn", 4);
            harness.faux.setResponses([fauxAssistantMessage("Stored baseline name")]);
            await harness.settled();

            expect(harness.faux.state.callCount).toBe(1);
            expect(harness.pi.sessionName).toBe("Stored baseline name");
        } finally {
            harness.dispose();
        }
    });

    it("does not revive older state when the newest persisted state is invalid", async () => {
        const harness = Harness.create();
        try {
            writeSettings(harness, createSettings());
            appendUserMessage(harness.session, "Fix the parser", 1);
            harness.session.appendCustomEntry(AUTONAME_STATE_ENTRY_TYPE, {
                version: 1,
                initialNameSet: false,
                baseline: { messages: 100, turns: 0, toolCalls: 0, tokens: 0 },
                baselineAtMs: 0,
            });
            harness.session.appendCustomEntry(AUTONAME_STATE_ENTRY_TYPE, {
                version: 1,
                initialNameSet: false,
                baseline: { messages: "invalid" },
                baselineAtMs: 0,
            });
            await harness.startSession();
            harness.faux.setResponses([fauxAssistantMessage("Recovered state name")]);

            await harness.settled();

            expect(allDiagnostics(harness)).toContain("Invalid session naming state");
            expect(harness.faux.state.callCount).toBe(1);
            expect(harness.pi.sessionName).toBe("Recovered state name");
        } finally {
            harness.dispose();
        }
    });

    it("accepts header-only picker authentication", async () => {
        const harness = Harness.create();
        try {
            writeSettings(harness, createSettings());
            harness.registry.setAuth({ ok: true, headers: { "x-api-key": "static-key" } });
            await harness.startSession();
            appendUserMessage(harness.session, "Fix the parser", 1);
            harness.faux.setResponses([fauxAssistantMessage("Header auth name")]);

            await harness.settled();

            expect(harness.pi.sessionName).toBe("Header auth name");
            expect(harness.faux.state.callCount).toBe(1);
        } finally {
            harness.dispose();
        }
    });

    it("rejects contradictory name constraints at the settings boundary", async () => {
        const harness = Harness.create();
        try {
            writeSettings(
                harness,
                createSettings({ nameConstraints: { minLength: 60, maxLength: 6 } }),
            );
            await harness.startSession();
            appendUserMessage(harness.session, "Fix the parser", 1);
            harness.faux.setResponses([fauxAssistantMessage("Should not run")]);

            await harness.settled();

            expect(harness.faux.state.callCount).toBe(0);
            expect(allDiagnostics(harness)).toContain("minLength is greater than maxLength");
        } finally {
            harness.dispose();
        }
    });

    it("accepts credential-free local picker endpoints", async () => {
        const harness = Harness.create();
        try {
            writeSettings(harness, createSettings());
            harness.registry.setAuth({ ok: true });
            await harness.startSession();
            appendUserMessage(harness.session, "Fix the parser", 1);
            harness.faux.setResponses([fauxAssistantMessage("Local endpoint name")]);

            await harness.settled();

            expect(harness.pi.sessionName).toBe("Local endpoint name");
            expect(harness.faux.state.callCount).toBe(1);
        } finally {
            harness.dispose();
        }
    });

    it("retries failed authentication after fresh activity without a model change", async () => {
        const harness = Harness.create();
        try {
            writeSettings(harness, createSettings());
            harness.registry.setAuth({ ok: false, error: "no credentials configured" });
            await harness.startSession();
            appendUserMessage(harness.session, "Fix the parser", 1);

            await harness.settled();
            expect(harness.faux.state.callCount).toBe(0);
            expect(allDiagnostics(harness)).toContain("no available authentication");

            // No fresh activity: bounded retry policy suppresses an immediate retry.
            await harness.settled();
            expect(harness.faux.state.callCount).toBe(0);

            // Authentication becomes available without a model-select event.
            harness.registry.setAuth({ ok: true, apiKey: "key" });
            appendUserMessage(harness.session, "More work", 2);
            harness.faux.setResponses([fauxAssistantMessage("Fixed name")]);
            await harness.settled();

            expect(harness.faux.state.callCount).toBe(1);
            expect(harness.pi.sessionName).toBe("Fixed name");
        } finally {
            harness.dispose();
        }
    });

    it("classifies a synchronous authentication resolver failure and can recover", async () => {
        const harness = Harness.create();
        try {
            writeSettings(harness, createSettings());
            harness.registry.setAuthenticationThrows();
            await harness.startSession();
            appendUserMessage(harness.session, "Fix the parser", 1);

            await harness.settled();
            expect(harness.faux.state.callCount).toBe(0);
            expect(allDiagnostics(harness)).toContain("authentication could not be resolved");

            harness.registry.setAuth({ ok: true, apiKey: "key" });
            appendUserMessage(harness.session, "More work", 2);
            harness.faux.setResponses([fauxAssistantMessage("Recovered auth name")]);
            await harness.settled();

            expect(harness.faux.state.callCount).toBe(1);
            expect(harness.pi.sessionName).toBe("Recovered auth name");
        } finally {
            harness.dispose();
        }
    });

    it("suppresses naming attempts while the picker model is unavailable", async () => {
        const harness = Harness.create();
        try {
            const modelReference = `${FAUX_PROVIDER}/${harness.model.id}`;
            writeSettings(harness, createSettings({ model: modelReference }));
            harness.registry.setModelAvailable(undefined);
            await harness.startSession();
            appendUserMessage(harness.session, "Fix the parser", 1);

            await harness.settled();
            expect(harness.faux.state.callCount).toBe(0);
            expect(allDiagnostics(harness)).toContain(
                `picker model "${modelReference}" is not available`,
            );

            // More activity: still blocked.
            appendUserMessage(harness.session, "More work", 2);
            await harness.settled();
            expect(harness.faux.state.callCount).toBe(0);

            // The model becomes resolvable and the user switches models.
            harness.registry.setModelAvailable(harness.model);
            await harness.modelSelect();
            harness.faux.setResponses([fauxAssistantMessage("Ghost name")]);
            await harness.settled();

            expect(harness.faux.state.callCount).toBe(1);
            expect(harness.pi.sessionName).toBe("Ghost name");
        } finally {
            harness.dispose();
        }
    });

    it("retries invalid picker output only after fresh activity", async () => {
        const harness = Harness.create();
        try {
            writeSettings(harness, createSettings());
            await harness.startSession();
            appendUserMessage(harness.session, "Fix the parser", 1);

            harness.faux.setResponses([fauxAssistantMessage("short")]);
            await harness.settled();
            expect(harness.faux.state.callCount).toBe(1);
            expect(harness.pi.sessionName).toBeUndefined();
            expect(allDiagnostics(harness)).toContain("unusable name");

            // No fresh activity: no retry.
            await harness.settled();
            expect(harness.faux.state.callCount).toBe(1);

            // Fresh activity re-reaches the trigger: the retry succeeds.
            appendUserMessage(harness.session, "More details", 2);
            harness.faux.setResponses([fauxAssistantMessage("Fix parser tests")]);
            await harness.settled();
            expect(harness.faux.state.callCount).toBe(2);
            expect(harness.pi.sessionName).toBe("Fix parser tests");
        } finally {
            harness.dispose();
        }
    });

    it("classifies provider failures without forwarding provider error text", async () => {
        const harness = Harness.create();
        try {
            writeSettings(harness, createSettings());
            await harness.startSession();
            appendUserMessage(harness.session, "Fix the parser", 1);

            harness.faux.setResponses([
                fauxAssistantMessage("ignored", {
                    stopReason: "error",
                    errorMessage: "internal endpoint SECRET-PATH failed",
                }),
            ]);
            await harness.settled();

            expect(harness.faux.state.callCount).toBe(1);
            expect(harness.pi.sessionName).toBeUndefined();
            expect(allDiagnostics(harness)).toContain("could not complete its request");
            expect(allDiagnostics(harness)).not.toContain("SECRET-PATH");

            // No fresh activity: no immediate retry.
            await harness.settled();
            expect(harness.faux.state.callCount).toBe(1);
        } finally {
            harness.dispose();
        }
    });

    it("times out slow picker requests and retries only after fresh activity", async () => {
        const harness = Harness.create();
        try {
            writeSettings(harness, createSettings({ timeoutMs: 1_000 }));
            await harness.startSession();
            appendUserMessage(harness.session, "Fix the parser", 1);

            harness.faux.setResponses([
                async (context, options) =>
                    new Promise<AssistantMessage>((resolve) => {
                        options?.signal?.addEventListener(
                            "abort",
                            () => resolve(fauxAssistantMessage("late")),
                            { once: true },
                        );
                    }),
            ]);
            await harness.settled();

            expect(harness.faux.state.callCount).toBe(1);
            expect(harness.pi.sessionName).toBeUndefined();
            expect(allDiagnostics(harness)).toContain("timed out");

            // No fresh activity: no retry.
            await harness.settled();
            expect(harness.faux.state.callCount).toBe(1);

            // Fresh activity: the retry succeeds.
            appendUserMessage(harness.session, "More work", 2);
            harness.faux.setResponses([fauxAssistantMessage("Timely name")]);
            await harness.settled();
            expect(harness.faux.state.callCount).toBe(2);
            expect(harness.pi.sessionName).toBe("Timely name");
        } finally {
            harness.dispose();
        }
    });

    it("applies timeoutMs while authentication resolution is pending", async () => {
        const harness = Harness.create();
        try {
            writeSettings(harness, createSettings({ timeoutMs: 1_000 }));
            const pendingAuth = createDeferred<TestAuthResult>();
            harness.registry.setPendingAuth(pendingAuth.promise);
            await harness.startSession();
            appendUserMessage(harness.session, "Fix the parser", 1);

            await harness.settled();

            expect(harness.faux.state.callCount).toBe(0);
            expect(harness.pi.sessionName).toBeUndefined();
            expect(allDiagnostics(harness)).toContain("timed out");

            // Settle the dependency after the extension has stopped waiting;
            // the late resolution must have no observable effect.
            pendingAuth.resolve({ ok: true, apiKey: "late-key" });
            await Promise.resolve();
            expect(harness.pi.sessionName).toBeUndefined();
        } finally {
            harness.dispose();
        }
    });

    it.each(["shutdown", "timeout"])(
        "observes late authentication rejection after %s without leaking or poisoning recovery",
        async (cancellation) => {
            const harness = Harness.create();
            const pendingAuth = createDeferred<TestAuthResult>();
            try {
                writeSettings(harness, createSettings({ timeoutMs: 1_000 }));
                harness.registry.setPendingAuth(pendingAuth.promise);
                await harness.startSession();
                await harness.beforeAgentStart("Fix the parser");
                await expect.poll(() => harness.registry.authCalls).toBe(1);

                if (cancellation === "shutdown") {
                    await harness.shutdown();
                    expect(harness.pi.notified).toEqual([]);
                } else {
                    await expect
                        .poll(() => allDiagnostics(harness), { timeout: 2_000 })
                        .toContain("timed out");
                    expect(harness.pi.notified).toHaveLength(1);
                }

                const diagnostics = [...harness.pi.notified];
                pendingAuth.reject(new Error("SECRET-LATE-AUTH-FAILURE"));

                await setImmediate();
                expect(harness.pi.notified).toEqual(diagnostics);
                expect(harness.pi.sessionNameCalls).toEqual([]);
                expect(stateEntries(harness)).toEqual([]);
                expect(harness.faux.state.callCount).toBe(0);

                harness.registry.setAuth({ ok: true, apiKey: "recovered-key" });

                if (cancellation === "shutdown") {
                    await harness.replaceSession(SessionManager.inMemory(harness.ctx.cwd));
                }

                appendUserMessage(harness.session, "Fresh parser activity", 1);
                harness.faux.setResponses([fauxAssistantMessage("Recovered authentication name")]);
                await harness.beforeAgentStart("Continue parser recovery");
                await expect
                    .poll(() => harness.pi.sessionName)
                    .toBe("Recovered authentication name");
                expect(harness.faux.state.callCount).toBe(1);
                expect(harness.pi.notified).toEqual(diagnostics);
                expect(allDiagnostics(harness)).not.toContain("SECRET-LATE-AUTH-FAILURE");
            } finally {
                pendingAuth.resolve({ ok: true });
                await harness.shutdown();
                harness.dispose();
            }
        },
    );

    it("handles background host rejection safely, deduplicates diagnostics, and recovers", async () => {
        const harness = Harness.create();
        try {
            writeSettings(harness, createSettings());
            await harness.startSession();
            harness.pi.sessionNameError = new Error("SECRET-HOST-FAILURE and private prompt text");
            harness.faux.setResponses([
                fauxAssistantMessage("First rejected name"),
                fauxAssistantMessage("Second rejected name"),
                fauxAssistantMessage("Recovered host name"),
            ]);

            await harness.beforeAgentStart("Fix the parser");
            await expect.poll(() => harness.pi.sessionNameCalls).toEqual(["First rejected name"]);
            await setImmediate();
            expect(harness.pi.notified).toEqual([
                { message: "Session naming failed unexpectedly.", severity: "warning" },
            ]);

            expect(harness.pi.sessionName).toBeUndefined();
            expect(harness.session.getSessionName()).toBeUndefined();
            expect(stateEntries(harness)).toEqual([]);

            await harness.beforeAgentStart("Try parser naming again");
            await expect.poll(() => harness.pi.sessionNameCalls).toHaveLength(2);
            await setImmediate();
            expect(harness.pi.notified).toHaveLength(1);
            expect(allDiagnostics(harness)).not.toContain("SECRET-HOST-FAILURE");
            expect(stateEntries(harness)).toEqual([]);

            harness.pi.sessionNameError = undefined;
            await harness.beforeAgentStart("Continue parser recovery");
            await expect.poll(() => harness.pi.sessionName).toBe("Recovered host name");
            await harness.flushEvents();
            expect(harness.faux.state.callCount).toBe(3);
            expect(stateEntries(harness)).toHaveLength(1);
            expect(latestState(harness)?.initialNameSet).toBe(true);
            expect(harness.pi.notified).toHaveLength(1);

            await expect(harness.shutdown()).resolves.toBeUndefined();
            await setImmediate();
            expect(harness.pi.sessionNameCalls).toHaveLength(3);
        } finally {
            await harness.shutdown();
            harness.dispose();
        }
    });

    it("waits for a cancelled background request to reject before shutdown finishes", async () => {
        const harness = Harness.create();
        const response = createDeferred<AssistantMessage>();
        let shutdown: Promise<void> | undefined;
        try {
            writeSettings(harness, createSettings());
            await harness.startSession();
            const requestStarted = createDeferred<void>();
            let signal: AbortSignal | undefined;
            harness.faux.setResponses([
                async (_context, options) => {
                    signal = options?.signal;
                    requestStarted.resolve(undefined);

                    return response.promise;
                },
            ]);
            await harness.beforeAgentStart("Fix the parser");
            await requestStarted.promise;
            let shutdownFinished = false;
            shutdown = harness.shutdown().then(() => {
                shutdownFinished = true;
            });
            await setImmediate();
            expect(signal?.aborted).toBe(true);
            expect(shutdownFinished).toBe(false);

            response.reject(new Error("SECRET-SHUTDOWN-FAILURE"));
            await shutdown;
            await setImmediate();
            expect(shutdownFinished).toBe(true);
            expect(harness.pi.sessionNameCalls).toEqual([]);
            expect(stateEntries(harness)).toEqual([]);
            expect(harness.pi.notified).toEqual([]);
            expect(harness.faux.state.callCount).toBe(1);

            await harness.replaceSession(SessionManager.inMemory(harness.ctx.cwd));
            harness.faux.setResponses([fauxAssistantMessage("Post shutdown name")]);
            appendUserMessage(harness.session, "New parser work", 1);
            await harness.settled();
            expect(harness.pi.sessionName).toBe("Post shutdown name");
            expect(harness.faux.state.callCount).toBe(2);
            expect(stateEntries(harness)).toHaveLength(1);
            expect(harness.pi.notified).toEqual([]);
        } finally {
            response.resolve(fauxAssistantMessage("Cleanup shutdown"));
            await shutdown;
            await harness.shutdown();
            harness.dispose();
        }
    });

    it("aborts and drains background prompt naming on session shutdown", async () => {
        const harness = Harness.create();
        try {
            writeSettings(harness, createSettings());
            await harness.startSession();

            const requestStarted = createDeferred<void>();
            harness.faux.setResponses([
                async (context, options) =>
                    new Promise<AssistantMessage>((resolve) => {
                        requestStarted.resolve(undefined);
                        options?.signal?.addEventListener(
                            "abort",
                            () => resolve(fauxAssistantMessage("Late name")),
                            { once: true },
                        );
                    }),
            ]);
            await harness.beforeAgentStart("Fix the parser");

            await requestStarted.promise;
            await harness.shutdown();

            expect(harness.pi.sessionName).toBeUndefined();
            expect(harness.faux.state.callCount).toBe(1);
        } finally {
            harness.dispose();
        }
    });

    it("does not rebuild naming state from its own rename events", async () => {
        const harness = Harness.create();
        try {
            writeSettings(harness, createSettings());
            await harness.startSession();
            appendUserMessage(harness.session, "Fix the parser", 1);
            harness.faux.setResponses([fauxAssistantMessage("Applied name")]);

            await harness.settled();
            await harness.flushEvents();

            expect(harness.pi.sessionName).toBe("Applied name");

            // Only the completion entry: the extension's own
            // session_info_changed event was suppressed while applying.
            expect(stateEntries(harness)).toHaveLength(1);
            expect(latestState(harness)).toEqual(expect.objectContaining({ initialNameSet: true }));
        } finally {
            harness.dispose();
        }
    });

    it("uses only the first active user request for settled initial naming", async () => {
        const harness = Harness.create();
        try {
            writeSettings(harness, createSettings());
            await harness.startSession();
            harness.session.appendMessage({
                role: "user",
                content: "old secret material in history",
                timestamp: 1,
            });
            const firstKeptId = appendAssistantTurn(harness.session, "old response", 2);
            harness.session.appendMessage({ role: "user", content: "new question", timestamp: 3 });
            harness.session.appendCompaction("summary of the old work", firstKeptId, 100);
            harness.session.appendMessage({
                role: "user",
                content: "newest question",
                timestamp: 4,
            });

            let capturedPrompt = "";
            harness.faux.setResponses([
                (context) => {
                    const content = context.messages[0]?.content;
                    const textBlock = Array.isArray(content)
                        ? content.find((block): block is TextContent => block.type === "text")
                        : undefined;
                    capturedPrompt = textBlock?.text ?? "";
                    return fauxAssistantMessage("Compacted name");
                },
            ]);

            await harness.settled();

            expect(harness.pi.sessionName).toBe("Compacted name");
            expect(capturedPrompt).toContain("USER:\nnew question");
            expect(capturedPrompt).not.toContain("summary of the old work");
            expect(capturedPrompt).not.toContain("newest question");
            expect(capturedPrompt).not.toContain("old secret material in history");
        } finally {
            harness.dispose();
        }
    });
});
