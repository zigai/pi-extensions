import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    CustomEditor,
    InteractiveMode,
    discoverAndLoadExtensions,
    ExtensionRunner,
    initTheme,
    ModelRegistry,
    ModelRuntime,
    SessionManager,
    type ExtensionContext,
    type SessionShutdownEvent,
    type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
    ProcessTerminal,
    SelectList,
    TuiMainScreen,
    type EditorTheme,
} from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { afterEach, beforeEach, test } from "vitest";

import {
    registerUiTweaksLifecycle,
    type UiTweaksExtensionApi,
    type UiTweaksLifecycleContext,
} from "../src/index.ts";
import { captureDiagnostics } from "./capture-diagnostics.ts";

let testDirectory: string;
let previousAgentDir: string | undefined;

beforeEach(async () => {
    testDirectory = await mkdtemp(path.join(tmpdir(), "pi-ui-lifecycle-"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(testDirectory, "agent");
});

afterEach(async () => {
    if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
    } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }

    await rm(testDirectory, { recursive: true, force: true });
});

type SelectListPrototypeFixture = {
    readonly render?: (width: number) => string[];
};

type LifecycleHandler = (
    event: SessionStartEvent | SessionShutdownEvent,
    ctx: UiTweaksLifecycleContext,
) => void | Promise<void>;

function registerLifecycleHandlers(): Map<string, LifecycleHandler> {
    const handlers = new Map<string, LifecycleHandler>();
    const api: UiTweaksExtensionApi = {
        onSessionStart(handler): void {
            handlers.set("session_start", handler);
        },
        onSessionShutdown(handler): void {
            handlers.set("session_shutdown", handler);
        },
    };
    registerUiTweaksLifecycle(api);

    return handlers;
}

function headlessContext(): UiTweaksLifecycleContext {
    return {
        cwd: testDirectory,
        hasUI: false,
        isProjectTrusted(): boolean {
            return true;
        },
        ui: {
            getEditorComponent() {
                return undefined;
            },
            notify(): void {},
            setEditorComponent(): void {},
            setWidget(): void {},
        },
    };
}

const sessionStart: SessionStartEvent = { type: "session_start", reason: "startup" };
const sessionShutdown: SessionShutdownEvent = { type: "session_shutdown", reason: "quit" };
const selectListPrototype: SelectListPrototypeFixture = SelectList.prototype;

test("composition root registers session lifecycle handlers", () => {
    const handlers = registerLifecycleHandlers();
    assert.equal(handlers.has("session_start"), true);
    assert.equal(handlers.has("session_shutdown"), true);
});

test("session shutdown disposes installed patches and a later start installs once again", async () => {
    const diagnostics = await captureDiagnostics(async () => {
        const handlers = registerLifecycleHandlers();
        const start = handlers.get("session_start");
        const shutdown = handlers.get("session_shutdown");
        assert.ok(start);
        assert.ok(shutdown);
        const context = headlessContext();
        const originalRender = selectListPrototype.render;

        await start(sessionStart, context);
        const firstPatchedRender = selectListPrototype.render;
        assert.notEqual(firstPatchedRender, originalRender);
        await start(sessionStart, context);
        assert.notEqual(selectListPrototype.render, firstPatchedRender);
        await shutdown(sessionShutdown, context);
        assert.equal(selectListPrototype.render, originalRender);
        await start(sessionStart, context);
        assert.notEqual(selectListPrototype.render, originalRender);
        await shutdown(sessionShutdown, context);
        assert.equal(selectListPrototype.render, originalRender);
    });

    assert.deepEqual(diagnostics, []);
});

test("shutdown rejects an in-flight activation and later starts remain reusable", async () => {
    const handlers = registerLifecycleHandlers();
    const start = handlers.get("session_start");
    const shutdown = handlers.get("session_shutdown");
    assert.ok(start);
    assert.ok(shutdown);
    const context = headlessContext();
    const original: unknown = Object.getOwnPropertyDescriptor(
        TuiMainScreen.prototype,
        "doRender",
    )?.value;
    const pending = start(sessionStart, context);

    await Promise.resolve();
    await shutdown(sessionShutdown, context);
    await pending;
    assert.equal(
        Object.getOwnPropertyDescriptor(TuiMainScreen.prototype, "doRender")?.value,
        original,
    );
    await start(sessionStart, context);
    assert.notEqual(
        Object.getOwnPropertyDescriptor(TuiMainScreen.prototype, "doRender")?.value,
        original,
    );
    await shutdown(sessionShutdown, context);
    assert.equal(
        Object.getOwnPropertyDescriptor(TuiMainScreen.prototype, "doRender")?.value,
        original,
    );
});

test.each([
    { settings: {}, dim: true },
    { settings: { dimInputBorder: false }, dim: false },
    { settings: { enabled: false, dimInputBorder: true }, dim: false },
])(
    "input borders respect defaults, individual settings and the master switch ($settings)",
    async ({ settings, dim }) => {
        const directory = path.join(testDirectory, "agent", "extension-settings");
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, "pi-ui-tweaks.json"), JSON.stringify(settings));
        const handlers = registerLifecycleHandlers();
        const start = handlers.get("session_start");
        const shutdown = handlers.get("session_shutdown");
        assert.ok(start);
        assert.ok(shutdown);
        const identity = (text: string): string => text;
        const theme: EditorTheme = {
            borderColor: (text) => `\u001b[31m${text}\u001b[39m`,
            selectList: {
                selectedPrefix: identity,
                selectedText: identity,
                description: identity,
                scrollInfo: identity,
                noMatch: identity,
            },
        };
        const editor = new CustomEditor(
            new TuiMainScreen(new ProcessTerminal()),
            theme,
            new KeybindingsManager(),
        );
        editor.setText("Draft ─ stays bright");
        const original = editor.render(32);
        const context = headlessContext();
        try {
            await start(sessionStart, context);
            const lines = editor.render(32);
            let expectedBorder = `\u001b[31m${"─".repeat(32)}\u001b[39m`;
            if (dim) expectedBorder = `\u001b[31m\u001b[2m${"─".repeat(32)}\u001b[22m\u001b[39m`;
            assert.equal(lines.at(0), expectedBorder);
            assert.equal(lines.at(-1), expectedBorder);
            assert.deepEqual(lines.slice(1, -1), original.slice(1, -1));
            editor.borderColor = (text) => `\u001b[34m${text}\u001b[39m`;
            const blue = editor.render(32);
            assert.equal(blue.at(0), expectedBorder.replace("[31m", "[34m"));
            assert.equal(blue.at(-1), expectedBorder.replace("[31m", "[34m"));
            await shutdown(sessionShutdown, context);
            const restored = editor.render(32);
            assert.equal(restored.at(0), `\u001b[34m${"─".repeat(32)}\u001b[39m`);
            assert.deepEqual(restored.slice(1, -1), original.slice(1, -1));
        } finally {
            await shutdown(sessionShutdown, context);
        }
    },
);

test.each([
    ["@zigai/pi-ui-tweaks", "@zigai/pi-model-modes"],
    ["@zigai/pi-model-modes", "@zigai/pi-ui-tweaks"],
])("dims the Model Modes editor with extension order %j then %j", async (first, second) => {
    initTheme("dark", false);
    const agentDir = path.join(testDirectory, "agent");
    const loaded = await discoverAndLoadExtensions(
        [first, second].map((name) => fileURLToPath(import.meta.resolve(name))),
        testDirectory,
        agentDir,
    );
    assert.deepEqual(loaded.errors, []);
    loaded.runtime.getThinkingLevel = () => "high";
    const models = await ModelRuntime.create({
        authPath: path.join(testDirectory, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
    });
    const runner = new ExtensionRunner(
        loaded.extensions,
        loaded.runtime,
        testDirectory,
        SessionManager.inMemory(testDirectory),
        new ModelRegistry(models),
    );

    type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

    let factory: EditorFactory | undefined;
    const notifications: string[] = [];
    runner.setUIContext(
        {
            ...runner.getUIContext(),
            getEditorComponent: () => factory,
            setEditorComponent(next) {
                factory = next;
            },
            notify(message) {
                notifications.push(message);
            },
        },
        "tui",
    );
    const identity = (text: string): string => text;
    const theme: EditorTheme = {
        borderColor: (text) => `\u001b[31m${text}\u001b[39m`,
        selectList: {
            selectedPrefix: identity,
            selectedText: identity,
            description: identity,
            scrollInfo: identity,
            noMatch: identity,
        },
    };
    try {
        await runner.emit(sessionStart);
        assert.deepEqual(notifications, []);
        assert.ok(factory);
        const editor = factory(
            new TuiMainScreen(new ProcessTerminal()),
            theme,
            new KeybindingsManager(),
        );
        editor.setText("Draft ─ stays bright");
        const lines = editor.render(32);
        const border = `\u001b[31m\u001b[2m${"─".repeat(32)}\u001b[22m\u001b[39m`;
        assert.equal(lines.at(0), border);
        assert.equal(lines.at(-1), border);
        assert.equal(lines.slice(1, -1).join("\n").includes("\u001b[2m"), false);
        assert.equal(editor.getText(), "Draft ─ stays bright");
        editor.setText("! command");
        assert.equal(editor.render(32).at(0)?.includes("\u001b[2m"), true);
        assert.equal(editor.render(32).at(-1)?.includes("\u001b[2m"), true);
        await runner.emit({ type: "session_shutdown", reason: "reload" });
        assert.equal(editor.render(32).join("\n").includes("\u001b[2m"), false);
        await runner.emit({ type: "session_start", reason: "reload" });
        const reloadedFactory = runner.getUIContext().getEditorComponent();
        assert.ok(reloadedFactory);
        const reloaded = reloadedFactory(
            new TuiMainScreen(new ProcessTerminal()),
            theme,
            new KeybindingsManager(),
        );
        reloaded.setText("Restored draft");
        assert.equal(reloaded.render(32).at(0), border);
        assert.equal(reloaded.render(32).at(-1), border);
        assert.equal(reloaded.getText(), "Restored draft");
    } finally {
        await runner.emit(sessionShutdown);
    }
});

test("registration alone never patches regular-mode rendering", () => {
    const original: unknown = Object.getOwnPropertyDescriptor(
        TuiMainScreen.prototype,
        "doRender",
    )?.value;
    registerLifecycleHandlers();
    assert.equal(
        Object.getOwnPropertyDescriptor(TuiMainScreen.prototype, "doRender")?.value,
        original,
    );
});

test("compact startup never patches non-TUI sessions", async () => {
    const configDirectory = path.join(process.env.PI_CODING_AGENT_DIR ?? "", "extension-settings");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
        path.join(configDirectory, "pi-ui-tweaks.json"),
        JSON.stringify({ compactStartup: true }),
    );
    const handlers = registerLifecycleHandlers();
    const start = handlers.get("session_start");
    const shutdown = handlers.get("session_shutdown");
    assert.ok(start);
    assert.ok(shutdown);
    const original = Object.getOwnPropertyDescriptor(
        InteractiveMode.prototype,
        "showLoadedResources",
    );
    try {
        await start(sessionStart, headlessContext());
        assert.deepEqual(
            Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "showLoadedResources"),
            original,
        );
    } finally {
        await shutdown(sessionShutdown, headlessContext());
    }
});
