import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    createAgentSessionServices,
    initTheme,
    InteractiveMode,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { ScrollView, TuiAltScreen, VStack, type Terminal } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import workspaceExtension from "../../src/index.ts";
import { containerSchema, hostRuntime } from "../../src/host-runtime.ts";

class TestTerminal implements Terminal {
    columns = 80;
    rows = 24;
    kittyProtocolActive = false;
    input: ((data: string) => void) | undefined;

    start(onInput: (data: string) => void): void {
        this.input = onInput;
    }

    stop(): void {
        this.input = undefined;
    }

    async drainInput(): Promise<void> {}

    write(): void {}

    moveBy(): void {}

    hideCursor(): void {}

    showCursor(): void {}

    clearLine(): void {}

    clearFromCursor(): void {}

    clearScreen(): void {}

    setTitle(): void {}

    setProgress(): void {}

    setProgramStatus(): void {}
}

const mountsSchema = Type.Object({
    documentContainer: containerSchema,
    editorContainer: containerSchema,
});

type UIFactory = (this: InteractiveMode) => ExtensionUIContext;

function isUIFactory(value: unknown): value is UIFactory {
    return typeof value === "function";
}

export async function createHost() {
    const root = await mkdtemp(join(process.cwd(), ".workspace-host-test-"));
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
                    extensionFactories: [workspaceExtension],
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

    const terminal = new TestTerminal();
    const interactive = new InteractiveMode(runtime, { terminal });
    const mounts = Compile(mountsSchema).Parse(interactive);

    const createUI: unknown = Object.getOwnPropertyDescriptor(
        InteractiveMode.prototype,
        "createExtensionUIContext",
    )?.value;
    if (!isUIFactory(createUI)) throw new Error("Host UI factory is missing");

    const ui = createUI.call(interactive);

    const layout = new VStack([
        { component: new ScrollView(mounts.documentContainer), grow: 1, minSize: 0 },
        { component: mounts.editorContainer, shrink: 0 },
    ]);
    Reflect.set(interactive, "fullscreenLayoutRoot", layout);

    const host = hostRuntime.parse(interactive);
    const renderer = host.renderer;
    if (!(renderer instanceof TuiAltScreen)) throw new Error("Full-screen renderer missing");

    renderer.setLayoutRoot(layout);
    await runtime.session.bindExtensions({ mode: "print" });

    const runner = runtime.session.extensionRunner;
    runner.setUIContext(ui, "tui");
    const ctx = runner.createCommandContext();

    host.ui.setFocus(host.editor);
    renderer.start();

    return {
        interactive,
        host,
        renderer,
        terminal,
        ctx,
        runner,
        session: runtime.session.sessionManager,
        async dispose(): Promise<void> {
            await runner.emit({ type: "session_shutdown", reason: "quit" });
            interactive.stop();
            await runtime.dispose();
            await rm(root, { recursive: true, force: true });
        },
    };
}
