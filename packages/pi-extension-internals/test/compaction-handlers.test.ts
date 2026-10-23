import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    type ExtensionAPI,
    type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    registerCompactionHandler,
    registerCompactionSelector,
    type CompactionHandlerHandle,
    type CompactionSelectionHandle,
} from "@zigai/pi-extension-internals/compaction-handlers";

type CompactionProtocol = {
    registerCompactionHandler: typeof registerCompactionHandler;
    registerCompactionSelector: typeof registerCompactionSelector;
};

function isCompactionProtocol(value: unknown): value is CompactionProtocol {
    return (
        typeof value === "object" &&
        value !== null &&
        "registerCompactionHandler" in value &&
        typeof value.registerCompactionHandler === "function" &&
        "registerCompactionSelector" in value &&
        typeof value.registerCompactionSelector === "function"
    );
}

const directories: string[] = [];
afterEach(async () => {
    for (const directory of directories.splice(0))
        await rm(directory, { recursive: true, force: true });
});

async function createSession(factory: (pi: ExtensionAPI) => void) {
    const cwd = await mkdtemp(join(tmpdir(), "pi-compaction-"));
    directories.push(cwd);
    const agentDir = join(cwd, "agent");
    await mkdir(agentDir);
    const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
    });
    modelRuntime.registerProvider("synthetic", {
        api: "openai-completions",
        apiKey: "synthetic-key",
        baseUrl: "http://localhost",
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
    });
    const model = modelRuntime.getModel("synthetic", "small");
    if (model === undefined) throw new Error("Synthetic model unavailable");

    const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 },
    });
    const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [{ name: "compaction-owners", factory }],
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.inMemory(cwd);
    sessionManager.appendMessage({
        role: "user",
        content: "Earlier synthetic work requiring a summary.",
        timestamp: 1,
    });
    sessionManager.appendMessage({
        role: "user",
        content: "Later synthetic work retained after summarization.",
        timestamp: 2,
    });
    const { session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime,
        model,
        resourceLoader,
        sessionManager,
        settingsManager,
        noTools: "builtin",
    });
    await session.bindExtensions({ mode: "print" });

    return session;
}

function summary(event: SessionBeforeCompactEvent, text: string) {
    return {
        compaction: {
            summary: text,
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
        },
    };
}

test("named compaction replacements switch at the next operation without changing an in-flight snapshot", async () => {
    const imported: unknown = await import(
        new URL("../dist/compaction-handlers.js?independent-copy", import.meta.url).href
    );
    if (!isCompactionProtocol(imported)) throw new Error("Compaction protocol unavailable");

    const handles: CompactionHandlerHandle[] = [];
    let selection: CompactionSelectionHandle | undefined;
    let choice = "first";

    let finish: () => void = () => {
        throw new Error("Handler not started");
    };

    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
        started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const session = await createSession((pi) => {
        handles.push(
            registerCompactionHandler(pi, "first", {
                available: () => true,
                async compact(event) {
                    started();
                    await pending;
                    return summary(event, "First handler summary");
                },
            }),
        );
        handles.push(
            imported.registerCompactionHandler(pi, "second", {
                available: () => true,
                async compact(event) {
                    return summary(event, "Second handler summary");
                },
            }),
        );
        selection = imported.registerCompactionSelector(pi, "policy", () => choice);
    });
    try {
        const operation = session.compact();
        await ready;
        choice = "second";
        finish();
        expect((await operation).summary).toBe("First handler summary");
        session.sessionManager.appendMessage({
            role: "user",
            content: "Additional synthetic work.",
            timestamp: 3,
        });

        expect((await session.compact()).summary).toBe("Second handler summary");
        expect(
            session.sessionManager
                .getEntries()
                .filter((entry) => entry.type === "compaction")
                .map((entry) => entry.summary),
        ).toEqual(["First handler summary", "Second handler summary"]);
    } finally {
        selection?.dispose();

        for (const handle of handles) handle.dispose();
        session.dispose();
    }
});

test.each(["missing", "failure", "conflict"] as const)(
    "%s compaction does not silently fall through or append a summary",
    async (failure) => {
        const handles: CompactionHandlerHandle[] = [];
        let selection: CompactionSelectionHandle | undefined;
        const session = await createSession((pi) => {
            handles.push(
                registerCompactionHandler(pi, "first", {
                    available: () => true,
                    async compact() {
                        throw new Error("Synthetic handler failure");
                    },
                }),
            );

            if (failure === "conflict")
                handles.push(
                    registerCompactionHandler(pi, "second", {
                        available: () => true,
                        async compact(event) {
                            return summary(event, "Must not be stored");
                        },
                    }),
                );
            else
                selection = registerCompactionSelector(pi, "policy", () => {
                    if (failure === "missing") return "unregistered";
                    return "first";
                });
        });
        try {
            await expect(session.compact()).rejects.toThrow("Compaction cancelled");
            expect(
                session.sessionManager.getEntries().filter((entry) => entry.type === "compaction"),
            ).toEqual([]);
        } finally {
            selection?.dispose();

            for (const handle of handles) handle.dispose();
            session.dispose();
        }
    },
);

test.each(["caller", "owner"] as const)(
    "%s cancellation discards an in-flight result and permits a fresh owner",
    async (cancellation) => {
        let api: ExtensionAPI | undefined;
        let handler: CompactionHandlerHandle | undefined;
        let selection: CompactionSelectionHandle | undefined;
        let started: () => void = () => {};
        const ready = new Promise<void>((resolve) => {
            started = resolve;
        });
        const session = await createSession((pi) => {
            api = pi;
            handler = registerCompactionHandler(pi, "first", {
                available: () => true,
                async compact(event) {
                    started();
                    await new Promise<void>((resolve) => {
                        event.signal.addEventListener("abort", () => resolve(), { once: true });
                    });

                    return summary(event, "Cancelled summary");
                },
            });
            selection = registerCompactionSelector(pi, "policy", () => "first");
        });
        try {
            const operation = session.compact();
            const rejected = expect(operation).rejects.toThrow("Compaction cancelled");
            await ready;

            if (cancellation === "caller") session.abortCompaction();
            else handler?.dispose();

            await rejected;
            expect(
                session.sessionManager.getEntries().filter((entry) => entry.type === "compaction"),
            ).toEqual([]);

            selection?.dispose();
            handler?.dispose();

            if (api === undefined) throw new Error("Compaction API unavailable");

            handler = registerCompactionHandler(api, "replacement", {
                available: () => true,
                async compact(event) {
                    return summary(event, "Replacement summary");
                },
            });
            expect((await session.compact()).summary).toBe("Replacement summary");
        } finally {
            selection?.dispose();
            handler?.dispose();
            session.dispose();
        }
    },
);
