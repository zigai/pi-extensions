import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type {
    Api,
    AssistantMessage,
    FauxProviderRegistration,
    Model,
    TextContent,
} from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import extension from "../src/index.ts";
import {
    AUTONAME_STATE_ENTRY_TYPE,
    parseSessionNamingState,
    type SessionNamingState,
} from "../src/session-naming.ts";
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

    getApiKeyAndHeaders(): Promise<TestAuthResult> {
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

type Handler = (event: { type: string } & Record<string, unknown>, ctx: TestContext) => unknown;

/**
 * Recording stand-in for the ExtensionAPI. Mirrors the real pi surface the
 * extension uses. Session-name state changes are synchronous, while their
 * session_info_changed notifications remain queued until flushEvents(),
 * matching Pi's fire-and-forget event dispatch interval.
 */
class FakePi {
    readonly handlers = new Map<string, Handler>();
    readonly appended: { customType: string; data: unknown }[] = [];
    readonly notified: { message: string; severity: "info" | "warning" | "error" }[] = [];
    sessionName: string | undefined = undefined;
    lastCtx: TestContext | undefined;
    private readonly pendingEvents: ({ type: string } & Record<string, unknown>)[] = [];

    on(event: string, handler: Handler): void {
        this.handlers.set(event, handler);
    }

    appendEntry<T = unknown>(customType: string, data?: T): void {
        this.appended.push({ customType, data });
        this.lastCtx?.sessionManager.appendCustomEntry(customType, data);
    }

    setSessionName(name: string): void {
        this.sessionName = name;
        if (this.lastCtx !== undefined) {
            this.lastCtx.sessionManager.appendSessionInfo(name);
            this.pendingEvents.push({ type: "session_info_changed", name });
        }
    }

    getSessionName(): string | undefined {
        return this.sessionName;
    }

    async emit(event: { type: string } & Record<string, unknown>, ctx: TestContext): Promise<void> {
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
        readonly session: SessionManager,
        readonly pi: FakePi,
        readonly ctx: TestContext,
    ) {}

    static create(): Harness {
        const agentDir = mkdtempSync(join(tmpdir(), "pi-autoname-session-test-"));
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const faux = registerFauxProvider({ api: FAUX_API, provider: FAUX_PROVIDER });
        // The extension only reads this subset of ExtensionAPI; the harness
        // implements exactly those members (on, appendEntry, setSessionName,
        // getSessionName), which is why the full interface is asserted away.
        // SAFETY: extension() registers handlers and reads session state
        // exclusively through these four members, so the narrower fake is
        // behaviorally complete for every path under test.
        const pi = new FakePi();
        const model = faux.getModel() as Model<Api>;
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
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the harness implements exactly the ExtensionAPI members the extension uses (on, appendEntry, setSessionName, getSessionName); the remaining members are unreachable through the extension factory, so narrowing the fake to ExtensionAPI is behaviorally sound for every path under test.
        extension(pi as unknown as ExtensionAPI);
        const harness = new Harness(agentDir, faux, model, registry, session, pi, ctx);
        pi.lastCtx = ctx;
        return harness;
    }

    dispose(): void {
        this.faux.unregister();
        rmSync(this.agentDir, { recursive: true, force: true });
        if (process.env.PI_CODING_AGENT_DIR === this.agentDir) {
            delete process.env.PI_CODING_AGENT_DIR;
        }
    }

    startSession(): Promise<void> {
        this.pi.sessionName = this.session.getSessionName();
        return this.pi.emit({ type: "session_start" }, this.ctx);
    }

    settled(): Promise<void> {
        return this.pi.emit({ type: "agent_settled" }, this.ctx);
    }

    rename(name: string): void {
        this.pi.setSessionName(name);
    }

    flushEvents(): Promise<void> {
        return this.pi.flushEvents();
    }

    navigateTree(newLeafId: string | null, oldLeafId: string | null): Promise<void> {
        return this.pi.emit({ type: "session_tree", newLeafId, oldLeafId }, this.ctx);
    }

    shutdown(): Promise<void> {
        return this.pi.emit({ type: "session_shutdown" }, this.ctx);
    }

    modelSelect(): Promise<void> {
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
        initialNaming: { enabled: true, trigger: "messages", threshold: 1 },
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

function writeSettings(harness: Harness, settings: ExtensionSettingsDocument): void {
    const settingsDir = join(harness.agentDir, "extension-settings");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, "pi-autoname-session.json"), JSON.stringify(settings), "utf8");
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

function createDeferred<T>(): {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
} {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

function stateEntries(harness: Harness): unknown[] {
    return harness.pi.appended
        .filter((entry) => entry.customType === AUTONAME_STATE_ENTRY_TYPE)
        .map((entry) => entry.data);
}

function latestState(harness: Harness): SessionNamingState | undefined {
    const entries = stateEntries(harness);
    return parseSessionNamingState(entries[entries.length - 1]);
}

function allDiagnostics(harness: Harness): string {
    return harness.pi.notified.map((notification) => notification.message).join(" ");
}

describe("extension orchestration", () => {
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
            harness.faux.setResponses([() => deferred.promise]);
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
                (context, options) =>
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
            harness.faux.setResponses([() => deferred.promise]);
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
            harness.faux.setResponses([() => deferred.promise]);
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
                (context, options) =>
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
                (context, options) =>
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

    it("aborts in-flight naming on session shutdown without applying results", async () => {
        const harness = Harness.create();
        try {
            writeSettings(harness, createSettings());
            await harness.startSession();
            appendUserMessage(harness.session, "Fix the parser", 1);

            const requestStarted = createDeferred<void>();
            harness.faux.setResponses([
                (context, options) =>
                    new Promise<AssistantMessage>((resolve) => {
                        requestStarted.resolve(undefined);
                        options?.signal?.addEventListener(
                            "abort",
                            () => resolve(fauxAssistantMessage("Late name")),
                            { once: true },
                        );
                    }),
            ]);
            const settled = harness.settled();

            await requestStarted.promise;
            await harness.shutdown();
            await settled;

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

    it("uses the compaction-aware entry list for the picker prompt", async () => {
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
                    const textBlock =
                        typeof content === "string"
                            ? undefined
                            : content?.find((block): block is TextContent => block.type === "text");
                    capturedPrompt = textBlock?.text ?? "";
                    return fauxAssistantMessage("Compacted name");
                },
            ]);

            await harness.settled();

            expect(harness.pi.sessionName).toBe("Compacted name");
            expect(capturedPrompt).toContain("summary of the old work");
            expect(capturedPrompt).toContain("new question");
            expect(capturedPrompt).toContain("newest question");
            expect(capturedPrompt).not.toContain("old secret material in history");
        } finally {
            harness.dispose();
        }
    });
});
