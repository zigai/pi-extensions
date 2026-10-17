import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createAgentSession,
    DefaultResourceLoader,
    type ExtensionAPI,
    type ExtensionFactory,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
    ACTIVATION_PROPOSAL_ACCEPTED_EVENT,
    ACTIVATION_READY_EVENT,
    CLEAR_ACTIVATION_PROPOSAL_EVENT,
    parseActivationProposalOwner,
    parseActivationReady,
    SET_ACTIVATION_PROPOSAL_EVENT,
    type ExtensionActivationProposal,
} from "./activation-coordination.ts";
import extension from "./index.ts";

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
): Promise<DefaultResourceLoader> {
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        extensionFactories,
        noSkills,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
    });
    await loader.reload();
    return loader;
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
