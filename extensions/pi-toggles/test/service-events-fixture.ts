import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createEventBus,
    SessionManager,
    type ExtensionAPI,
    type ExtensionContext,
    type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TogglesService } from "../src/toggles-service.ts";
import { parseGoalPolicy } from "../src/goal-policy.ts";
import {
    parseRegisterContextKey,
    parseSetContext,
    parseClearContext,
} from "../src/context-facts.ts";
import type { SettingsDocument } from "../src/settings.ts";

/** Real service + settings/facts/catalog/resolver/reconciliation; only the Pi host is synthetic. */
export function serviceEventsFixture(
    options: {
        toolCount?: number;
        settings?: SettingsDocument;
        Service?: typeof TogglesService;
    } = {},
) {
    const root = mkdtempSync(join(tmpdir(), "toggles-service-events-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    mkdirSync(join(root, "extension-settings"));
    writeFileSync(
        join(root, "extension-settings", "pi-toggles.json"),
        JSON.stringify(options.settings ?? {}),
    );
    const events = createEventBus();
    const counts = { catalogs: 0, allTools: 0, activeReads: 0, writes: 0, events: 0 };
    const tools: ToolInfo[] = [];
    let active: string[] = [];
    let sessionId = "session-one";
    function addTool(name: string) {
        tools.push({
            name,
            description: `Tool ${name}`,
            parameters: Type.Object({ value: Type.Optional(Type.String()) }),
            exposure: "direct",
            sourceInfo: {
                source: "inline",
                scope: "temporary",
                origin: "top-level",
                path: `<inline:${name}>`,
            },
        });
        active.push(name);
    }
    addTool("ask_user_question");
    for (let index = 0; index < (options.toolCount ?? 20); index++) addTool(`tool_${index}`);
    const unused = (): never => {
        throw new Error("Unexpected service fixture API access");
    };
    const sessionManager = Object.assign(SessionManager.inMemory(root), {
        getSessionId: () => sessionId,
    });
    const pi: ExtensionAPI = {
        events,
        getAllTools() {
            counts.allTools++;
            return [...tools];
        },
        getActiveTools() {
            counts.activeReads++;
            return [...active];
        },
        setActiveTools(names: string[]) {
            counts.writes++;
            active = [...names];
        },
        getCommands() {
            counts.catalogs++;
            return [];
        },
        getSessionName: () => undefined,
        getThinkingLevel: () => "medium",
        appendEntry(customType, data) {
            sessionManager.appendCustomEntry(customType, data);
        },
        registerTool: unused,
        registerCommand: unused,
        registerShortcut: unused,
        registerFlag: unused,
        getFlag: unused,
        registerMessageRenderer: unused,
        registerMarkdownTransformer: unused,
        registerEntryRenderer: unused,
        registerToolRenderer: unused,
        sendMessage: unused,
        sendUserMessage: unused,
        setSessionName: unused,
        setLabel: unused,
        getSettings: unused,
        setModel: unused,
        setThinkingLevel: unused,
        registerProvider: unused,
        unregisterProvider: unused,
        registerMcpServer: unused,
        unregisterMcpServer: unused,
        getMcpServers: unused,
        registerVirtualModel: unused,
        unregisterVirtualModel: unused,
        on: () => () => {},
        exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false, truncated: false }),
    };
    const ctx: ExtensionContext = {
        cwd: root,
        mode: "print",
        hasUI: false,
        isProjectTrusted: () => true,
        sessionManager,
        get ui() {
            return unused();
        },
        get modelRegistry() {
            return unused();
        },
        model: undefined,
        scopedModels: [],
        signal: undefined,
        isIdle: () => true,
        hasPendingMessages: () => false,
        abort: unused,
        shutdown: unused,
        getContextUsage: () => undefined,
        compact: unused,
        getSystemPrompt: () => "",
    };
    const Service = options.Service ?? TogglesService;
    let service = new Service(pi, ctx);
    const subscriptions = [
        events.on("pi-goal:tool-policy", (value) => {
            counts.events++;
            const parsed = parseGoalPolicy(value);
            if (parsed !== undefined) service.acceptGoalPolicy(parsed);
        }),
        events.on("pi-toggles:register-context-key", (value) => {
            counts.events++;
            const parsed = parseRegisterContextKey(value);
            if (parsed.status === "ok") service.registerContextKey(parsed.value);
        }),
        events.on("pi-toggles:set-context", (value) => {
            counts.events++;
            const parsed = parseSetContext(value);
            if (parsed.status === "ok") service.setContext(parsed.value);
        }),
        events.on("pi-toggles:clear-context", (value) => {
            counts.events++;
            const parsed = parseClearContext(value);
            if (parsed.status === "ok") service.clearContext(parsed.value);
        }),
    ];
    return {
        pi,
        ctx,
        counts,
        addTool,
        get active() {
            return [...active];
        },
        get service() {
            return service;
        },
        async reset(nextSessionId = "session-two") {
            await service.settleActivation();
            service.dispose();
            sessionId = nextSessionId;
            sessionManager.newSession();
            service = new Service(pi, ctx);
            await service.initialize();
        },
        async close() {
            await service.settleActivation();
            service.dispose();
            for (const unsubscribe of subscriptions) unsubscribe();
            if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            rmSync(root, { recursive: true, force: true });
        },
    };
}
