import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, VStack, type Component } from "@earendil-works/pi-tui";
import {
    installLinkedMethodPatch,
    registerEditorBackend as installEditorBackend,
} from "@zigai/pi-extension-internals";
import { Type, type StaticDecode } from "typebox";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import {
    createWorkspaceEditor,
    editorBackends,
    type EditorBackend,
    type EditorFactory,
} from "./editor.ts";
import { editorDraftSchema, getEditorDraftAdapter } from "./editor-draft.ts";
import {
    componentSchema,
    editorSchema,
    getHostPrototype,
    hostRuntime,
    type WorkspaceHost,
} from "./host-runtime.ts";
import {
    createSidebar,
    layoutBackends,
    observeSidebarProviders,
    type WorkspaceLayout,
    type WorkspaceSummary,
} from "./layout.ts";
import { transcriptBackends, type TranscriptMetadata, type TranscriptView } from "./transcript.ts";
import { showStoredHistory } from "./history-browser.ts";
import type { WorkspaceSettings } from "./settings.ts";

const viewportSchema = Type.Object({
    setLayoutRoot: Type.Function([Type.Optional(componentSchema)], Type.Void()),
    layoutRoot: Type.Optional(componentSchema),
    renderNow: Type.Function([Type.Optional(Type.Boolean())], Type.Void()),
    terminal: Type.Object({ columns: Type.Number() }),
});

const toolIdentitySchema = Type.Object({
    toolCallId: Type.String(),
    toolName: Type.String(),
    args: Type.Unknown(),
});
const messageSchema = Type.Object({ role: Type.String(), timestamp: Type.Number() });
const messages = Compile(messageSchema);
const liveMessageSchema = Type.Object({
    type: Type.Union([Type.Literal("message_start"), Type.Literal("message_end")]),
    message: messageSchema,
});
const timeoutSchema = Type.Object({ timeout: Type.Number() });
const timeoutSecondsSchema = Type.Object({ timeoutSeconds: Type.Number() });
const compactionEndSchema = Type.Object({
    type: Type.Literal("compaction_end"),
    aborted: Type.Literal(false),
    result: Type.Object({ summary: Type.String() }),
});
const marker = Symbol.for("zigai.pi-workspace.host-patches");

type ViewportMount = {
    readonly base: Component;
    ownsRoot(): boolean;
    activate(): void;
    suspend(): void;
    dispose(): void;
};

class WorkingIndicator extends Text {
    constructor(private readonly ctx: ExtensionContext) {
        super("", 0, 0);
    }

    override render(width: number): string[] {
        if (this.ctx.isIdle()) this.setText("Workspace · Idle");
        else this.setText("Workspace · Working");

        return super.render(width);
    }
}

export class Workspace {
    static assertAvailable(): void {
        if (Object.getOwnPropertyDescriptor(getHostPrototype(), marker) !== undefined)
            throw new Error("Workspace host is already owned");
    }

    private host: WorkspaceHost | undefined;
    private readonly patches: { dispose(): void }[] = [];
    private rowPatches: { dispose(): void }[] = [];
    private readonly stopEditor: (() => void) | undefined;
    private editorBackend: EditorBackend | undefined;
    private editorBackendName: string | undefined;

    private readonly editorHandle:
        | { update(factory: EditorFactory): void; dispose(): void }
        | undefined;

    private view: TranscriptView | undefined;
    private mount: Component | undefined;
    private viewport: ViewportMount | undefined;
    private readonly facts = new WeakMap<Component, TranscriptMetadata>();
    private readonly rowMessages = new WeakMap<Component, StaticDecode<typeof messageSchema>>();
    private readonly messageFacts = new Map<unknown, TranscriptMetadata>();
    private readonly startedTools = new Map<string, number>();
    private readonly durations = new Map<string, number>();
    private fullHistoryDepth = 0;
    private disposed = false;
    private readonly prototype = getHostPrototype();

    constructor(
        private readonly ctx: ExtensionContext,
        private settings: WorkspaceSettings,
    ) {
        Workspace.assertAvailable();

        try {
            Workspace.installPatches(this);
            this.editorHandle = installEditorBackend(ctx, createWorkspaceEditor);
            Object.defineProperty(this.prototype, marker, { configurable: true, value: this });
            this.editorBackend = editorBackends.current;
            this.editorBackendName = editorBackends.name;
            this.stopEditor = editorBackends.observe(() => {
                if (
                    this.editorBackend === editorBackends.current &&
                    this.editorBackendName === editorBackends.name
                )
                    return;

                this.editorHandle?.update(createWorkspaceEditor);
                this.editorBackend = editorBackends.current;
                this.editorBackendName = editorBackends.name;
            });
            this.patches.push({
                dispose: transcriptBackends.observe(() => this.replaceTranscript()),
            });
            this.patches.push({ dispose: layoutBackends.observe(() => this.replaceLayout()) });
            this.patches.push({ dispose: observeSidebarProviders(() => this.replaceLayout()) });
        } catch (cause) {
            this.dispose();
            throw cause;
        }
    }

    update(settings: WorkspaceSettings): void {
        const previous = this.settings;
        this.settings = settings;

        try {
            if (this.host !== undefined) this.capture(this.host, true);
        } catch (cause) {
            this.settings = previous;
            throw cause;
        }
    }

    recordToolStart(id: string): void {
        this.startedTools.set(id, performance.now());
    }

    recordToolEnd(id: string): void {
        const started = this.startedTools.get(id);
        this.startedTools.delete(id);

        if (started !== undefined) this.durations.set(id, performance.now() - started);
        this.host?.ui.requestRender();
    }

    rebuild(): void {
        if (this.host !== undefined) this.prototype.rebuildChatFromMessages.call(this.host);
    }

    dispose(): void {
        if (this.disposed) return;

        this.disposed = true;

        try {
            this.editorHandle?.dispose();
        } catch (cause) {
            this.disposed = false;
            throw cause;
        }

        this.stopEditor?.();
        this.unmount();

        for (const patch of [...this.patches].reverse()) patch.dispose();
        this.patches.length = 0;
        if (Object.getOwnPropertyDescriptor(this.prototype, marker)?.value === this)
            Reflect.deleteProperty(this.prototype, marker);

        this.startedTools.clear();
        this.durations.clear();
        this.messageFacts.clear();
    }

    private static installPatches(workspace: Workspace): void {
        workspace.patches.push(
            installLinkedMethodPatch(
                workspace.prototype,
                "setCustomEditorComponent",
                (predecessor) =>
                    function (factory): void {
                        const host = hostRuntime.parse(this);
                        if (
                            host.sessionManager.getSessionId() !==
                            workspace.ctx.sessionManager.getSessionId()
                        ) {
                            predecessor.call(this, factory);
                            return;
                        }

                        if (!workspace.disposed) {
                            let mounted: Component = host.chatContainer;
                            if (
                                workspace.host?.chatContainer === host.chatContainer &&
                                workspace.mount !== undefined
                            )
                                mounted = workspace.mount;

                            if (!host.documentContainer.children.includes(mounted))
                                throw new Error("Another frontend owns the transcript mount");

                            if (
                                host.renderer.mode === "fullscreen" &&
                                !Value.Check(viewportSchema, host.renderer)
                            )
                                throw new Error(
                                    "Pi full-screen workspace rendering is unsupported",
                                );

                            if (
                                host.renderer.mode !== "fullscreen" &&
                                layoutBackends.name !== "native"
                            )
                                throw new Error("Workspace layouts require full-screen TUI mode");
                        }

                        const previousEditor = host.editor;
                        const source = getEditorDraftAdapter(previousEditor);
                        const draft = Value.Decode(editorDraftSchema, source.capture());
                        let prepared: typeof host.editor = host.defaultEditor;
                        if (factory !== undefined) {
                            const created = factory(
                                host.ui,
                                host.defaultEditor.theme,
                                host.keybindings,
                            );
                            if (!Value.Check(editorSchema, created))
                                throw new Error(
                                    "Editor backend returned an incompatible component",
                                );

                            prepared = created;
                        }

                        const target = getEditorDraftAdapter(prepared);
                        if (prepared !== previousEditor) {
                            try {
                                target.restore(draft);
                            } catch (cause) {
                                target.dispose();
                                throw cause;
                            }
                        }

                        const previousFactory = host.editorComponentFactory;

                        try {
                            predecessor.call(this, () => prepared);
                            host.editorComponentFactory = factory;
                            target.restore(draft);
                            workspace.capture(host);
                        } catch (cause) {
                            host.editor = previousEditor;
                            host.editorComponentFactory = previousFactory;
                            source.restore(draft);
                            host.editorContainer.clear();
                            host.editorContainer.addChild(previousEditor);
                            host.ui.setFocus(previousEditor);
                            host.ui.requestRender();

                            if (prepared !== previousEditor) target.dispose();
                            throw cause;
                        }

                        if (prepared !== previousEditor) source.dispose();
                    },
            ),
        );
        workspace.patches.push(
            installLinkedMethodPatch(
                workspace.prototype,
                "renderInitialMessages",
                (predecessor) =>
                    function (): void {
                        workspace.fullHistoryDepth += 1;

                        try {
                            predecessor.call(this);
                        } finally {
                            workspace.fullHistoryDepth -= 1;
                        }
                    },
            ),
        );
        workspace.patches.push(
            installLinkedMethodPatch(
                workspace.prototype,
                "rebuildChatFromMessages",
                (predecessor) =>
                    function (): void {
                        workspace.fullHistoryDepth += 1;

                        try {
                            predecessor.call(this);
                        } finally {
                            workspace.fullHistoryDepth -= 1;
                        }
                    },
            ),
        );
        workspace.patches.push(
            installLinkedMethodPatch(
                workspace.prototype,
                "renderSessionEntries",
                (predecessor) =>
                    function (entries, options): void {
                        const host = hostRuntime.parse(this);
                        if (
                            host.sessionManager.getSessionId() ===
                            workspace.ctx.sessionManager.getSessionId()
                        ) {
                            workspace.capture(host);

                            const branch = workspace.ctx.sessionManager.getBranch();

                            workspace.messageFacts.clear();

                            for (const entry of branch)
                                if (entry.type === "message")
                                    workspace.messageFacts.set(entry.message, {
                                        id: entry.id,
                                        timestamp: entry.timestamp,
                                    });

                            if (workspace.fullHistoryDepth > 0) entries = [...branch];
                        }

                        predecessor.call(this, entries, options);
                        workspace.view?.refresh();
                    },
            ),
        );
        workspace.patches.push(
            installLinkedMethodPatch(
                workspace.prototype,
                "addMessageToChat",
                (predecessor) =>
                    function (message, options): void {
                        const host = hostRuntime.parse(this);
                        if (
                            host.sessionManager.getSessionId() !==
                                workspace.ctx.sessionManager.getSessionId() ||
                            workspace.disposed
                        ) {
                            predecessor.call(this, message, options);
                            return;
                        }

                        const count = host.chatContainer.children.length;
                        predecessor.call(this, message, options);

                        if (
                            !workspace.messageFacts.has(message) &&
                            workspace.fullHistoryDepth === 0
                        ) {
                            for (const entry of workspace.ctx.sessionManager.getBranch())
                                if (entry.type === "message")
                                    workspace.messageFacts.set(entry.message, {
                                        id: entry.id,
                                        timestamp: entry.timestamp,
                                    });
                        }

                        const component = host.chatContainer.children.slice(count).at(-1);
                        if (component !== undefined) workspace.recordMessage(component, message);
                        workspace.view?.refresh();
                    },
            ),
        );
        workspace.patches.push(
            installLinkedMethodPatch(
                workspace.prototype,
                "setupExtensionShortcuts",
                (predecessor) =>
                    function (runner): void {
                        predecessor.call(this, runner);

                        const host = hostRuntime.parse(this);
                        if (
                            host.sessionManager.getSessionId() ===
                                workspace.ctx.sessionManager.getSessionId() &&
                            host.editor !== host.defaultEditor
                        )
                            host.editor.onExtensionShortcut =
                                host.defaultEditor.onExtensionShortcut;
                    },
            ),
        );
        workspace.patches.push(
            installLinkedMethodPatch(
                workspace.prototype,
                "handleReloadCommand",
                (predecessor) =>
                    async function (): Promise<void> {
                        const host = hostRuntime.parse(this);
                        const session = host.sessionManager.getSessionId();
                        if (
                            session !== workspace.ctx.sessionManager.getSessionId() ||
                            workspace.disposed
                        ) {
                            await predecessor.call(this);
                            return;
                        }

                        const draft = getEditorDraftAdapter(host.editor).capture();

                        await predecessor.call(this);

                        const current = hostRuntime.parse(this);
                        if (current.sessionManager.getSessionId() === session) {
                            getEditorDraftAdapter(current.editor).restore(draft);
                            current.ui.requestRender();
                        }
                    },
            ),
        );
        workspace.patches.push(
            installLinkedMethodPatch(
                workspace.prototype,
                "handleEvent",
                (predecessor) =>
                    async function (event): Promise<void> {
                        const host = hostRuntime.parse(this);
                        const streaming = host.streamingComponent;
                        await predecessor.call(this, event);

                        if (
                            workspace.disposed ||
                            host.sessionManager.getSessionId() !==
                                workspace.ctx.sessionManager.getSessionId()
                        )
                            return;

                        if (
                            Value.Check(liveMessageSchema, event) &&
                            event.message.role === "assistant"
                        ) {
                            let component = host.streamingComponent;
                            if (event.type === "message_end") component = streaming;

                            if (component !== undefined) {
                                workspace.recordMessage(component, event.message);
                                workspace.view?.refresh();
                                host.ui.requestRender();
                            }
                        }

                        if (Value.Check(compactionEndSchema, event)) workspace.rebuild();
                    },
            ),
        );
        workspace.patches.push(
            installLinkedMethodPatch(
                workspace.prototype,
                "switchTuiMode",
                (predecessor) =>
                    function (mode, restoreProgress, startRenderer): boolean {
                        const host = hostRuntime.parse(this);
                        if (
                            workspace.disposed ||
                            host.sessionManager.getSessionId() !==
                                workspace.ctx.sessionManager.getSessionId()
                        )
                            return predecessor.call(this, mode, restoreProgress, startRenderer);

                        if (mode !== "fullscreen" && layoutBackends.name !== "native") {
                            workspace.ctx.ui.notify(
                                "Select the native layout before entering regular mode.",
                                "warning",
                            );
                            return false;
                        }

                        const result = predecessor.call(this, mode, restoreProgress, startRenderer);
                        if (result) {
                            workspace.capture(hostRuntime.parse(this));
                            workspace.replaceLayout();
                        }

                        return result;
                    },
            ),
        );
    }

    private capture(host: WorkspaceHost, replace = false): void {
        if (this.disposed) return;

        if (!replace && this.host?.chatContainer === host.chatContainer) {
            this.host = host;
            return;
        }

        const previousHost = this.host;
        const previousView = this.view;
        const previousMount = this.mount;
        const previousViewport = this.viewport;
        const previousPatches = this.rowPatches;
        let mounted: Component = host.chatContainer;
        if (previousHost?.chatContainer === host.chatContainer && previousMount !== undefined)
            mounted = previousMount;

        const index = host.documentContainer.children.indexOf(mounted);
        if (index < 0) throw new Error("Transcript mount is no longer owned");

        const view = this.createTranscript(host);
        let viewport: ViewportMount | undefined;
        try {
            viewport = this.prepareViewport(host);
        } catch (cause) {
            view.dispose();
            throw cause;
        }

        const patches: { dispose(): void }[] = [];
        const refresh = (): void => {
            this.view?.refresh();
        };

        try {
            previousViewport?.suspend();
            host.documentContainer.children.splice(index, 1, view.component);
            this.host = host;
            this.view = view;
            this.mount = view.component;
            this.viewport = viewport;
            this.rowPatches = patches;

            for (const key of ["addChild", "removeChild"] as const) {
                patches.push(
                    installLinkedMethodPatch(
                        host.chatContainer,
                        key,
                        (predecessor) =>
                            function (component): void {
                                predecessor.call(this, component);
                                refresh();
                            },
                    ),
                );
            }

            patches.push(
                installLinkedMethodPatch(
                    host.chatContainer,
                    "clear",
                    (predecessor) =>
                        function (): void {
                            predecessor.call(this);
                            refresh();
                        },
                ),
            );

            viewport?.activate();
        } catch (cause) {
            viewport?.dispose();

            for (const patch of patches.reverse()) patch.dispose();
            host.documentContainer.children.splice(index, 1, mounted);
            this.host = previousHost;
            this.view = previousView;
            this.mount = previousMount;
            this.viewport = previousViewport;
            this.rowPatches = previousPatches;
            previousViewport?.activate();
            view.dispose();

            throw cause;
        }

        if (previousHost !== undefined && previousMount !== undefined && previousHost !== host) {
            const previousIndex = previousHost.documentContainer.children.indexOf(previousMount);
            if (previousIndex >= 0)
                previousHost.documentContainer.children.splice(
                    previousIndex,
                    1,
                    previousHost.chatContainer,
                );
        }

        for (const patch of previousPatches.reverse()) patch.dispose();
        previousView?.dispose();
        previousViewport?.dispose();
        host.ui.requestRender();
    }

    private recordMessage(component: Component, message: unknown): void {
        const parsed = messages.Parse(message);
        const metadata: TranscriptMetadata = {
            ...this.messageFacts.get(parsed),
            role: parsed.role,
        };
        if (
            metadata.timestamp === undefined &&
            parsed.role !== "compactionSummary" &&
            parsed.role !== "branchSummary"
        )
            Object.assign(metadata, { timestamp: new Date(parsed.timestamp).toISOString() });

        this.rowMessages.set(component, parsed);
        this.facts.set(component, metadata);
    }

    private metadata(component: Component): TranscriptMetadata {
        let recorded = this.facts.get(component) ?? {};
        const message = this.rowMessages.get(component);
        if (message !== undefined && recorded.id === undefined) {
            const entry = this.ctx.sessionManager
                .getBranch()
                .find((entry) => entry.type === "message" && entry.message === message);
            if (entry !== undefined) {
                recorded = { ...recorded, id: entry.id, timestamp: entry.timestamp };
                this.facts.set(component, recorded);
            }
        }

        if (!Value.Check(toolIdentitySchema, component)) return recorded;

        const result = this.ctx.sessionManager
            .getBranch()
            .find(
                (entry) =>
                    entry.type === "message" &&
                    entry.message.role === "toolResult" &&
                    entry.message.toolCallId === component.toolCallId,
            );
        const metadata: TranscriptMetadata = {
            id: result?.id,
            timestamp: result?.timestamp,
            role: component.toolName,
            durationMs: this.durations.get(component.toolCallId),
        };
        if (component.toolName === "bash" && Value.Check(timeoutSchema, component.args))
            Object.assign(metadata, { timeoutSeconds: component.args.timeout });
        else if (Value.Check(timeoutSecondsSchema, component.args))
            Object.assign(metadata, { timeoutSeconds: component.args.timeoutSeconds });

        return metadata;
    }

    private createTranscript(host: WorkspaceHost): TranscriptView {
        const source = {
            native: host.chatContainer,
            metadata: (component: Component) => this.metadata(component),
            openEntry: (id: string): void => {
                void showStoredHistory(this.ctx, "", id).catch(() =>
                    this.ctx.ui.notify("Stored entry could not be displayed.", "error"),
                );
            },
            metadataFields: {
                timestamp: this.settings.timestamps,
                duration: this.settings.durations,
                timeout: this.settings.timeouts,
            },
        };
        const next = transcriptBackends.current.create(source);
        if (!Value.Check(componentSchema, next.component)) {
            next.dispose();
            throw new Error("Transcript backend returned an incompatible component");
        }

        return next;
    }

    private replaceTranscript(): void {
        const host = this.host;
        if (host === undefined || this.disposed) return;

        const next = this.createTranscript(host);
        const previous = this.mount ?? host.chatContainer;
        const index = host.documentContainer.children.indexOf(previous);
        if (index < 0) {
            next.dispose();
            throw new Error("Transcript mount is no longer owned");
        }

        host.documentContainer.children.splice(index, 1, next.component);
        this.view?.dispose();
        this.view = next;
        this.mount = next.component;
        host.ui.requestRender();
    }

    private summary(): WorkspaceSummary {
        return {
            cwd: this.ctx.cwd,
            session:
                this.ctx.sessionManager.getSessionName() ?? this.ctx.sessionManager.getSessionId(),
            leaf: this.ctx.sessionManager.getLeafId() ?? "root",
            working: !this.ctx.isIdle(),
        };
    }

    private createLayout(root: Component, sidebar: Component): WorkspaceLayout {
        const layout = layoutBackends.current.create({
            native: new VStack([
                { component: new WorkingIndicator(this.ctx), basis: 1, shrink: 0 },
                { component: root, grow: 1, minSize: 0 },
            ]),
            sidebar,
            settings: {
                side: this.settings.sidebarSide,
                width: this.settings.sidebarWidth,
                minimumMainWidth: this.settings.minimumMainWidth,
            },
        });
        if (!Value.Check(componentSchema, layout.component)) {
            layout.dispose();
            throw new Error("Layout backend returned an incompatible component");
        }

        return layout;
    }

    private prepareViewport(host: WorkspaceHost): ViewportMount | undefined {
        if (host.renderer.mode !== "fullscreen") {
            if (layoutBackends.name !== "native")
                throw new Error("Workspace layouts require full-screen TUI mode");

            return undefined;
        }

        if (!Value.Check(viewportSchema, host.renderer))
            throw new Error("Pi full-screen workspace rendering is unsupported");

        const viewport = host.renderer;
        let base = viewport.layoutRoot ?? host.fullscreenLayoutRoot;
        if (this.viewport?.ownsRoot() === true) base = this.viewport.base;

        const sidebar = createSidebar(() => this.summary());
        let layout: WorkspaceLayout;
        try {
            layout = this.createLayout(base, sidebar.component);
        } catch (cause) {
            sidebar.dispose();
            throw cause;
        }

        let patch: { dispose(): void } | undefined;
        let disposed = false;
        const ownsRoot = (): boolean => viewport.layoutRoot === layout.component;
        const suspend = (): void => {
            if (patch === undefined) return;

            const owned = ownsRoot();

            patch.dispose();
            patch = undefined;

            if (owned) viewport.setLayoutRoot(base);
        };

        return {
            get base(): Component {
                return base;
            },
            ownsRoot,
            activate: (): void => {
                if (patch !== undefined) return;

                let prepared: WorkspaceLayout | undefined = layout;

                patch = installLinkedMethodPatch(
                    viewport,
                    "setLayoutRoot",
                    (predecessor) =>
                        (root): void => {
                            if (root === undefined) {
                                predecessor.call(viewport, root);
                                return;
                            }

                            const next = prepared ?? this.createLayout(root, sidebar.component);

                            prepared = undefined;

                            try {
                                predecessor.call(viewport, next.component);
                            } catch (cause) {
                                if (next !== layout) next.dispose();
                                throw cause;
                            }

                            base = root;

                            const previous = layout;
                            layout = next;

                            if (previous !== next) previous.dispose();
                        },
                );

                try {
                    viewport.setLayoutRoot(base);
                } catch (cause) {
                    suspend();
                    throw cause;
                }
            },
            suspend,
            dispose: (): void => {
                if (disposed) return;

                suspend();
                disposed = true;
                layout.dispose();
                sidebar.dispose();
            },
        };
    }

    private replaceLayout(): void {
        const host = this.host;
        if (host === undefined || this.disposed) return;

        const next = this.prepareViewport(host);
        const previous = this.viewport;

        try {
            previous?.suspend();
            next?.activate();
        } catch (cause) {
            next?.dispose();
            previous?.activate();
            throw cause;
        }

        this.viewport = next;
        previous?.dispose();
        host.ui.requestRender();
    }

    private clearViewport(): void {
        this.viewport?.dispose();
        this.viewport = undefined;
    }

    private unmount(): void {
        this.clearViewport();

        const host = this.host;
        if (host !== undefined && this.mount !== undefined) {
            const index = host.documentContainer.children.indexOf(this.mount);
            if (index >= 0) host.documentContainer.children.splice(index, 1, host.chatContainer);
            host.ui.requestRender();
        }

        this.view?.dispose();
        this.view = undefined;
        this.mount = undefined;
        for (const patch of this.rowPatches.reverse()) patch.dispose();
        this.rowPatches = [];
    }
}
