import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    registerFauxProvider,
    streamSimple,
} from "@earendil-works/pi-ai/compat";
import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    type AgentSession,
    type ExtensionError,
} from "@earendil-works/pi-coding-agent";

const [packageDirArgument, runtimeDir] = process.argv.slice(2);
if (packageDirArgument === undefined || runtimeDir === undefined) {
    throw new Error("Expected installed package and disposable runtime directories.");
}

const packageDir = packageDirArgument;
const agentDir = join(runtimeDir, "agent");
const cwd = join(runtimeDir, "project");
const sessionDir = join(runtimeDir, "sessions");
process.env.PI_CODING_AGENT_DIR = agentDir;

await mkdir(cwd, { recursive: true });
await mkdir(join(agentDir, "extension-settings"), { recursive: true });

const settingsPath = join(agentDir, "extension-settings", "pi-autoname-session.json");
await writeFile(
    settingsPath,
    JSON.stringify({
        initialNaming: { timing: "settled" },
        refreshNaming: { enabled: true, trigger: "messages", threshold: 2 },
    }),
);

const faux = registerFauxProvider({ api: "package-test", provider: "package-test" });
const model = faux.getModel();
const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
});
modelRuntime.registerProvider(model.provider, {
    api: faux.api,
    apiKey: "test-key",
    baseUrl: model.baseUrl,
    models: [model],
    streamSimple,
});
await modelRuntime.refresh({ allowNetwork: false });

const errors: ExtensionError[] = [];
const stateEntryType = "pi-autoname-session.state";
let activeSession: AgentSession | undefined;

async function openSession(sessionManager: SessionManager): Promise<AgentSession> {
    const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        additionalExtensionPaths: [packageDir],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
    });

    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.length, 1);

    const { session } = await createAgentSession({
        cwd,
        agentDir,
        model,
        modelRuntime,
        resourceLoader: loader,
        sessionManager,
        settingsManager,
        noTools: "all",
    });

    activeSession = session;
    await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });

    return session;
}

async function closeSession(): Promise<void> {
    const session = activeSession;
    if (session === undefined) {
        return;
    }

    try {
        await session.abort();
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
        session.dispose();
        activeSession = undefined;
    }
}

try {
    const manager = SessionManager.create(cwd, sessionDir);
    const first = await openSession(manager);

    faux.setResponses([
        fauxAssistantMessage("I will inspect parser recovery."),
        fauxAssistantMessage("Fix parser recovery"),
    ]);
    await first.prompt("Fix parser recovery after malformed input", {
        expandPromptTemplates: false,
    });
    await first.waitForIdle();
    await first.extensionRunner.emit({ type: "agent_settled" });
    for (let i = 0; i < 200 && manager.getSessionName() === undefined; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (errors.length > 0) {
        throw new Error(`Extension errors encountered: ${JSON.stringify(errors)}`);
    }
    assert.equal(manager.getSessionName(), "Fix parser recovery");
    assert.equal(faux.state.callCount, 2);
    faux.setResponses([fauxAssistantMessage("I will also inspect incomplete tokens.")]);
    await first.prompt("Include incomplete tokens in parser recovery", {
        expandPromptTemplates: false,
    });
    await first.waitForIdle();
    await first.extensionRunner.emit({ type: "agent_settled" });
    for (let i = 0; i < 50 && manager.getSessionName() === undefined; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (errors.length > 0) {
        throw new Error(`Extension errors encountered on second prompt: ${JSON.stringify(errors)}`);
    }
    assert.equal(manager.getSessionName(), "Fix parser recovery");
    assert.equal(faux.state.callCount, 3);

    const savedState = manager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === stateEntryType);
    assert.equal(savedState.length, 1);
    const sessionFile = manager.getSessionFile();
    if (sessionFile === undefined) {
        throw new Error("Expected a persisted session file.");
    }

    await closeSession();

    const reopened = SessionManager.open(sessionFile, sessionDir);
    assert.equal(reopened.getSessionName(), "Fix parser recovery");
    assert.deepEqual(
        reopened
            .getBranch()
            .filter((entry) => entry.type === "custom" && entry.customType === stateEntryType),
        savedState,
    );

    const resumed = await openSession(reopened);
    assert.equal(faux.state.callCount, 3);
    assert.equal(reopened.getSessionName(), "Fix parser recovery");
    faux.setResponses([
        fauxAssistantMessage("I will cover truncated literals too."),
        fauxAssistantMessage("Handle incomplete parser input"),
    ]);
    await resumed.prompt("Also cover truncated string literals", { expandPromptTemplates: false });
    await resumed.waitForIdle();
    assert.equal(faux.state.callCount, 5);
    assert.equal(reopened.getSessionName(), "Handle incomplete parser input");
    assert.equal(
        reopened
            .getBranch()
            .filter((entry) => entry.type === "custom" && entry.customType === stateEntryType)
            .length,
        2,
    );
    assert.equal(faux.getPendingResponseCount(), 0);
    await closeSession();
    assert.equal(
        SessionManager.open(sessionFile, sessionDir).getSessionName(),
        "Handle incomplete parser input",
    );
    assert.deepEqual(errors, []);
    assert.equal(
        await readFile(
            join(agentDir, "extension-settings", "schemas", "pi-autoname-session.schema.json"),
            "utf8",
        ),
        await readFile(join(packageDir, "config.schema.json"), "utf8"),
    );

    process.stdout.write(
        "Installed package named and restored the session and refresh baseline.\n",
    );
} finally {
    try {
        await closeSession();
    } finally {
        faux.unregister();
    }
}
