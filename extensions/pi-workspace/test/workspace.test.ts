import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    createAgentSessionServices,
    CustomEditor,
    initTheme,
    InteractiveMode,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text, VStack } from "@earendil-works/pi-tui";
import { installLinkedMethodPatch } from "@zigai/pi-extension-internals";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { attachEditorDraftAdapter, getEditorDraftAdapter } from "../src/editor-draft.ts";
import { componentSchema, getHostPrototype, hostRuntime } from "../src/host-runtime.ts";
import { layoutBackends, registerLayoutBackend, registerSidebarProvider } from "../src/layout.ts";
import { settingsSchema } from "../src/settings-input.ts";
import {
    registerTranscriptBackend,
    transcriptBackends,
    type TranscriptSource,
} from "../src/transcript.ts";
import { Workspace } from "../src/workspace.ts";
import { registerEditorBackend, selectEditorBackend } from "../src/editor.ts";
import { createHost } from "./support/host.ts";

type EditorFactory = Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];
type InteractiveEditorSetter = (this: InteractiveMode, factory: EditorFactory) => void;

function isInteractiveEditorSetter(value: unknown): value is InteractiveEditorSetter {
    return typeof value === "function";
}

type AssistantMessage = Extract<
    Parameters<SessionManager["appendMessage"]>[0],
    { role: "assistant" }
>;

function assistant(text: string, timestamp: number): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp,
        api: "openai-responses",
        provider: "sample-local",
        model: "sample",
        stopReason: "stop",
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
    };
}

it("rejects workspace activation while busy without detaching live assistant or tool rows, then permits idle retry", async () => {
    const fixture = await createHost();
    try {
        const prototype = getHostPrototype();
        await prototype.handleEvent.call(fixture.interactive, {
            type: "message_start",
            message: assistant("Streaming", 1000),
        });
        await prototype.handleEvent.call(fixture.interactive, {
            type: "tool_execution_start",
            toolCallId: "live-tool",
            toolName: "bash",
            args: { command: "echo sample" },
        });
        const before = [...fixture.host.chatContainer.children];
        expect(before).toHaveLength(2);
        const command = fixture.runner
            .getRegisteredCommands()
            .find((item) => item.name === "workspace-on");
        if (command === undefined) throw new Error("Workspace command missing");

        const editor = fixture.host.editor;
        await command.handler("", { ...fixture.ctx, isIdle: () => false });
        expect(fixture.host.chatContainer.children.slice(0, 2)).toEqual(before);
        expect(fixture.host.editor).toBe(editor);
        Workspace.assertAvailable();
        await command.handler("", { ...fixture.ctx, isIdle: () => true });
        expect(() => Workspace.assertAvailable()).toThrow("already owned");
    } finally {
        await fixture.dispose();
    }
});

it("live message metadata gains assistant role and persisted identity after message_end without rebuilding rows", async () => {
    const fixture = await createHost();
    let source: TranscriptSource | undefined;
    const native = transcriptBackends.current;
    const registration = registerTranscriptBackend("observe-live", {
        create(next) {
            source = next;
            return native.create(next);
        },
    });
    transcriptBackends.select("observe-live");
    let workspace: Workspace | undefined;
    try {
        const settings = Value.Decode(settingsSchema, Value.Default(settingsSchema, {}));
        workspace = new Workspace(fixture.ctx, settings);
        const prototype = getHostPrototype();
        const initial = assistant("Partial", 1000);
        await prototype.handleEvent.call(fixture.interactive, {
            type: "message_start",
            message: initial,
        });
        const row = fixture.host.chatContainer.children.at(-1);
        if (row === undefined || source === undefined) throw new Error("Live transcript missing");

        expect(source.metadata(row)).toEqual({
            role: "assistant",
            timestamp: "1970-01-01T00:00:01.000Z",
        });
        const final = assistant("Final response", 1000);
        await prototype.handleEvent.call(fixture.interactive, {
            type: "message_end",
            message: final,
        });
        const id = fixture.session.appendMessage(final);
        const entry = fixture.session.getEntry(id);
        expect(source.metadata(row)).toEqual({
            id,
            role: "assistant",
            timestamp: entry?.timestamp,
        });
        const user = { role: "user" as const, content: "Next prompt", timestamp: 2000 };
        await prototype.handleEvent.call(fixture.interactive, {
            type: "message_start",
            message: user,
        });
        const userRow = fixture.host.chatContainer.children.at(-1);
        if (userRow === undefined) throw new Error("User row missing");

        const userId = fixture.session.appendMessage(user);
        expect(source.metadata(userRow)).toEqual({
            id: userId,
            role: "user",
            timestamp: fixture.session.getEntry(userId)?.timestamp,
        });

        expect(fixture.host.chatContainer.children.at(0)).toBe(row);
    } finally {
        workspace?.dispose();
        registration.dispose();
        await fixture.dispose();
    }
});

const viewportSchema = Type.Object({
    setLayoutRoot: Type.Function([Type.Optional(componentSchema)], Type.Void()),
    layoutRoot: Type.Optional(componentSchema),
});

it.each(["sidebar", "transcript", "layout", "viewport"])(
    "retains the complete surface after %s preparation or mounting rejects, then permits retry and off",
    async (boundary) => {
        const root = await mkdtemp(join(process.cwd(), ".workspace-test-"));
        const settingsManager = SettingsManager.inMemory({ tuiMode: "fullscreen" });
        const modelRuntime = await ModelRuntime.create({
            authPath: join(root, "auth.json"),
            modelsPath: null,
            allowModelNetwork: false,
            refreshOnCreate: false,
        });
        modelRuntime.registerProvider("sample-local", {
            api: "sample-local",
            apiKey: "nonsecret",
            baseUrl: "http://127.0.0.1:1",
            models: [
                {
                    id: "sample",
                    name: "Sample",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 10000,
                    maxTokens: 100,
                },
            ],
            streamSimple() {
                throw new Error("Model dispatch is forbidden in workspace tests");
            },
        });
        const model = modelRuntime.getModel("sample-local", "sample");
        if (model === undefined) throw new Error("Synthetic model is missing");

        const runtime = await createAgentSessionRuntime(
            async (options) => {
                const services = await createAgentSessionServices({
                    ...options,
                    modelRuntime,
                    settingsManager,
                    resourceLoaderOptions: {
                        noExtensions: true,
                        noSkills: true,
                        noThemes: true,
                        noPromptTemplates: true,
                        noContextFiles: true,
                    },
                });
                const result = await createAgentSessionFromServices({
                    services,
                    sessionManager: options.sessionManager,
                    model,
                    noTools: "all",
                });

                return { ...result, services, diagnostics: services.diagnostics };
            },
            { cwd: root, agentDir: root, sessionManager: SessionManager.inMemory(root) },
        );
        initTheme("dark");
        const interactive = new InteractiveMode(runtime);
        const document: unknown = Object.getOwnPropertyDescriptor(
            interactive,
            "documentContainer",
        )?.value;
        if (!Value.Check(componentSchema, document))
            throw new Error("Interactive document is missing");

        Reflect.set(interactive, "fullscreenLayoutRoot", new VStack([document]));
        const host = hostRuntime.parse(interactive);
        await runtime.session.bindExtensions({ mode: "print" });
        const runner = runtime.session.extensionRunner;
        const baseContext = runner.createContext();
        let factory: EditorFactory;
        const ctx: ExtensionContext = {
            ...baseContext,
            hasUI: true,
            ui: {
                ...baseContext.ui,
                getEditorComponent: () => factory,
                setEditorComponent: (next) => {
                    const setter: unknown = Object.getOwnPropertyDescriptor(
                        InteractiveMode.prototype,
                        "setCustomEditorComponent",
                    )?.value;
                    if (!isInteractiveEditorSetter(setter))
                        throw new Error("Interactive editor setter is missing");

                    setter.call(interactive, next);
                    factory = next;
                },
            },
        };
        let originalDisposals = 0;
        const original: EditorFactory = (ui, theme, keys) => {
            const editor = new CustomEditor(ui, theme, keys);
            const adapter = getEditorDraftAdapter(editor);
            attachEditorDraftAdapter(editor, {
                ...adapter,
                dispose: () => {
                    originalDisposals += 1;
                    adapter.dispose();
                },
            });

            return editor;
        };
        ctx.ui.setEditorComponent(original);
        host.editor.setText("Generic draft α\nsecond line");
        host.editor.handleInput(
            `\u001b[200~${Array.from({ length: 14 }, (_, i) => `paste row ${i + 1}`).join("\n")}\u001b[201~`,
        );
        host.editor.handleInput("\u001b[A");
        host.editor.handleInput("\u001b[D");
        const originalDraft = getEditorDraftAdapter(host.editor);
        const seeded = originalDraft.capture();
        seeded.history = ["earlier draft", "α history"];
        seeded.historyIndex = 0;
        seeded.historyDraft = { lines: ["history browsing draft"], cursorLine: 0, cursorCol: 3 };
        seeded.killRing = ["killed text", "older kill"];
        seeded.preferredVisualCol = 3;
        seeded.snappedFromCursorCol = 2;
        seeded.pasteBuffer = "partial bracketed paste";
        seeded.isInPaste = true;
        originalDraft.restore(seeded);
        expect(seeded.undo.length).toBeGreaterThan(0);
        expect(seeded.document.pastes.length).toBeGreaterThan(0);
        let reject = true;
        const check = (name: string): void => {
            if (reject && boundary === name) {
                if (name === "viewport") reject = false;
                throw new Error(`Rejected ${name}`);
            }
        };

        const nativeTranscript = transcriptBackends.current;
        const nativeLayout = layoutBackends.current;
        const transcript = registerTranscriptBackend("sample", {
            create: (source) => {
                check("transcript");
                return nativeTranscript.create(source);
            },
        });
        const layout = registerLayoutBackend("sample", {
            create: (source) => {
                check("layout");
                return nativeLayout.create(source);
            },
        });
        transcriptBackends.select("sample");
        layoutBackends.select("sample");
        const sidebar = registerSidebarProvider("sample", {
            title: "Sample",
            create: () => {
                check("sidebar");
                return { component: new Text("Sample", 0, 0), dispose() {} };
            },
        });
        const viewport: unknown = host.renderer;
        if (!Value.Check(viewportSchema, viewport)) throw new Error("Viewport is incompatible");

        const fault = installLinkedMethodPatch(
            viewport,
            "setLayoutRoot",
            (predecessor) =>
                function (root): void {
                    check("viewport");
                    predecessor.call(this, root);
                },
        );
        const settings = Value.Decode(settingsSchema, Value.Default(settingsSchema, {}));
        expect(settings.enabled).toBe(false);
        const snapshot = () => ({
            editor: host.editor,
            factory: host.editorComponentFactory,
            draft: getEditorDraftAdapter(host.editor).capture(),
            mount: [...host.documentContainer.children],
            root: viewport.layoutRoot,
        });

        const assertUnchanged = (before: ReturnType<typeof snapshot>): void => {
            const after = snapshot();
            expect(after.editor).toBe(before.editor);
            expect(after.factory).toBe(before.factory);
            expect(after.draft).toEqual(before.draft);
            expect(after.mount).toEqual(before.mount);
            expect(after.root).toBe(before.root);
        };
        let workspace: Workspace | undefined;
        try {
            const before = snapshot();
            expect(() => new Workspace(ctx, settings)).toThrow(`Rejected ${boundary}`);
            assertUnchanged(before);
            expect(originalDisposals).toBe(0);

            reject = false;
            workspace = new Workspace(ctx, settings);
            expect(originalDisposals).toBe(1);
            expect(getEditorDraftAdapter(host.editor).capture()).toEqual(before.draft);
            const active = snapshot();
            reject = true;
            expect(() => workspace?.update({ ...settings, timestamps: true })).toThrow(
                `Rejected ${boundary}`,
            );

            assertUnchanged(active);
            expect(() => Workspace.assertAvailable()).toThrow("already owned");
            expect(originalDisposals).toBe(1);

            reject = false;
            workspace.update({ ...settings, timestamps: true });
            const beforeBackendChange = snapshot();
            const rejecting = registerEditorBackend("rejecting-draft", {
                create: (ui, theme, keys) => {
                    const editor = new CustomEditor(ui, theme, keys);
                    const adapter = getEditorDraftAdapter(editor);
                    attachEditorDraftAdapter(editor, {
                        ...adapter,
                        restore: () => {
                            throw new Error("Draft rejected");
                        },
                    });

                    return editor;
                },
            });
            try {
                expect(() => selectEditorBackend("rejecting-draft")).toThrow("Draft rejected");
                assertUnchanged(beforeBackendChange);
            } finally {
                rejecting.dispose();
            }

            const replacement = registerEditorBackend("sample-editor", {
                create: (ui, theme, keys) => new CustomEditor(ui, theme, keys),
            });
            try {
                selectEditorBackend("sample-editor");
                expect(host.editor).not.toBe(beforeBackendChange.editor);
                expect(getEditorDraftAdapter(host.editor).capture()).toEqual(before.draft);
                host.editor.render(80);
                selectEditorBackend("native");
            } finally {
                replacement.dispose();
            }

            // Rendering may adjust viewport-only fields; all editing state remains intact.
            const afterBackendChange = getEditorDraftAdapter(host.editor).capture();
            expect({ ...afterBackendChange, scrollOffset: before.draft.scrollOffset }).toEqual(
                before.draft,
            );

            workspace.dispose();
            workspace = undefined;
            expect(ctx.ui.getEditorComponent()).toBe(original);
            expect(getEditorDraftAdapter(host.editor).capture()).toEqual(afterBackendChange);
            workspace = new Workspace(ctx, settings);
            workspace.dispose();
            workspace = undefined;
            Workspace.assertAvailable();
        } finally {
            reject = false;
            workspace?.dispose();
            fault.dispose();
            sidebar.dispose();
            layout.dispose();
            transcript.dispose();
            interactive.stop();
            await runtime.dispose();
            await rm(root, { recursive: true, force: true });
        }
    },
);
