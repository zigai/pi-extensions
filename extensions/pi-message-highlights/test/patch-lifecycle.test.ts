/* oxlint-disable typescript/no-unsafe-type-assertion -- Installed private Pi modules and partial host fixture are checked at their use sites with documented SAFETY invariants. */
import assert from "node:assert/strict";
import { test } from "vitest";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
    Editor,
    Markdown,
    stripTerminalSequences,
    TuiMainScreen,
    type EditorTheme,
    type MarkdownTheme,
    type Terminal,
} from "@earendil-works/pi-tui";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
    installMessageHighlightPatch,
    loadMessageHighlightTargets,
} from "../src/message-highlight-patch.ts";
import { DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG } from "../src/settings.ts";
import plainUserMessagesExtension from "../../pi-plain-user-messages/src/index.ts";
import responseRendererExtension from "../../pi-response-renderer/src/index.ts";

type RenderPrototype = {
    render: (this: MessageComponent, width: number) => string[];
};

type MessageComponent = {
    render: (this: MessageComponent, width: number) => string[];
};

/** Declared shapes of the unexported Pi message component module exports. */
type AssistantMessageModuleView = {
    AssistantMessageComponent?:
        | ((new (
              message: AssistantMessage,
              hideThinkingBlock: boolean,
              theme: MarkdownTheme,
              hiddenThinkingLabel: string,
              outputPad: number,
          ) => MessageComponent) & {
              prototype?: {
                  render?: unknown;
                  updateContent?: (this: MessageComponent, message: AssistantMessage) => void;
              };
          })
        | undefined;
};

type UserMessageModuleView = {
    UserMessageComponent?:
        | ((new (text: string, theme: MarkdownTheme, outputPad: number) => MessageComponent) & {
              prototype?: { render?: unknown };
          })
        | undefined;
};

type ThemeSnapshot = {
    readonly key: symbol;
    readonly descriptor: PropertyDescriptor | undefined;
};

const PI_THEME_KEYS = [
    Symbol.for("@earendil-works/pi-coding-agent:theme"),
    Symbol.for("@mariozechner/pi-coding-agent:theme"),
] as const;

/** Declared shape of the unexported Pi theme module surface used by these tests. */
type ThemeRuntimeModule = {
    initTheme?: unknown;
    stopThemeWatcher?: unknown;
};

function restoreThemeSnapshot(
    themeModule: ThemeRuntimeModule,
    snapshots: readonly ThemeSnapshot[],
): void {
    const stopThemeWatcher = themeModule.stopThemeWatcher;
    if (typeof stopThemeWatcher === "function") {
        stopThemeWatcher.call(themeModule);
    }

    for (const snapshot of snapshots) {
        if (snapshot.descriptor !== undefined) {
            Object.defineProperty(globalThis, snapshot.key, snapshot.descriptor);
            continue;
        }

        Reflect.deleteProperty(globalThis, snapshot.key);
    }
}

function suspendPiTheme(): () => void {
    const snapshots: ThemeSnapshot[] = PI_THEME_KEYS.map((key) => ({
        key,
        descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
    }));

    for (const key of PI_THEME_KEYS) Reflect.deleteProperty(globalThis, key);

    return (): void => {
        for (const snapshot of snapshots) {
            if (snapshot.descriptor !== undefined) {
                Object.defineProperty(globalThis, snapshot.key, snapshot.descriptor);
                continue;
            }

            Reflect.deleteProperty(globalThis, snapshot.key);
        }
    };
}

async function initializePiTheme(): Promise<() => void> {
    const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const themeUrl = pathToFileURL(
        join(dirname(codingAgentEntry), "modes/interactive/theme/theme.js"),
    ).href;

    // Pi's theme module is an internal runtime file with no public package export.
    // SAFETY: The dynamic import yields a namespace object; initTheme is verified callable
    // below before it is invoked, and every other member stays untouched.
    const themeModule = (await import(themeUrl)) as ThemeRuntimeModule;
    const initTheme = themeModule.initTheme;
    if (typeof initTheme !== "function") {
        assert.fail("missing initTheme");
    }

    const snapshots: ThemeSnapshot[] = PI_THEME_KEYS.map((key) => ({
        key,
        descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
    }));
    try {
        initTheme.call(themeModule, undefined, false);
    } catch (cause) {
        restoreThemeSnapshot(themeModule, snapshots);
        throw cause;
    }

    return (): void => {
        restoreThemeSnapshot(themeModule, snapshots);
    };
}

const identity = (text: string): string => text;
const markdownTheme = {
    heading: identity,
    link: identity,
    linkUrl: identity,
    code: identity,
    codeBlock: identity,
    codeBlockBorder: identity,
    quote: identity,
    quoteBorder: identity,
    hr: identity,
    listBullet: identity,
    bold: identity,
    italic: identity,
    strikethrough: identity,
    underline: identity,
} satisfies MarkdownTheme;

const editorTheme = {
    borderColor: identity,
    selectList: {
        selectedPrefix: identity,
        selectedText: identity,
        description: identity,
        scrollInfo: identity,
        noMatch: identity,
    },
} satisfies EditorTheme;

class FakeTerminal implements Terminal {
    columns = 80;
    rows = 24;

    get kittyProtocolActive(): boolean {
        return false;
    }

    start(): void {}

    stop(): void {}

    async drainInput(): Promise<void> {}

    write(_data: string): void {}

    moveBy(): void {}

    hideCursor(): void {}

    showCursor(): void {}

    clearLine(): void {}

    clearFromCursor(): void {}

    clearScreen(): void {}

    setTitle(): void {}

    setProgress(): void {}
}

const ESC = String.fromCharCode(0x1b);

/** Verifies one component prototype exposes the render method the patches wrap. */
function verifiedRenderPrototype<P extends { render?: unknown }>(
    prototype: P | undefined,
    label: string,
): P & RenderPrototype {
    if (typeof prototype?.render !== "function") {
        assert.fail(`invalid ${label} prototype`);
    }

    // SAFETY: The runtime check proves render is callable; the patches wrap only that method
    // and forward `this`, so the remaining prototype shape is irrelevant here.
    return prototype as P & RenderPrototype;
}

async function loadAssistantMessageComponent(): Promise<
    NonNullable<AssistantMessageModuleView["AssistantMessageComponent"]>
> {
    // SAFETY: Resolved from the installed Pi package at runtime; the export is verified
    // callable below before any member is read.
    const module = (await import("@earendil-works/pi-coding-agent")) as AssistantMessageModuleView;
    const component = module.AssistantMessageComponent;
    if (component === undefined) assert.fail("missing AssistantMessageComponent");
    return component;
}

async function loadUserMessageComponent(): Promise<
    NonNullable<UserMessageModuleView["UserMessageComponent"]>
> {
    // SAFETY: Resolved from the installed Pi package at runtime; the export is verified
    // present below before any member is read.
    const module = (await import("@earendil-works/pi-coding-agent")) as UserMessageModuleView;
    const component = module.UserMessageComponent;
    if (component === undefined) assert.fail("missing UserMessageComponent");
    return component;
}

type LifecycleApi = {
    readonly api: NonNullable<Parameters<typeof plainUserMessagesExtension>[0]>;
    readonly shutdownHandlers: Array<() => void>;
};

function createLifecycleApi(): LifecycleApi {
    const shutdownHandlers: Array<() => void> = [];
    const api = {
        on(event: string, handler: () => void): void {
            if (event === "session_shutdown") shutdownHandlers.push(handler);
        },
    };

    return { api, shutdownHandlers };
}

test("message render wrappers restore cleanly across reload cycles", async () => {
    const originalPiFlag = process.env.PI_CODING_AGENT;
    process.env.PI_CODING_AGENT = "true";
    const restoreOriginalTheme = suspendPiTheme();
    let restoreInitializedTheme: (() => void) | undefined;
    try {
        const assistantClass = await loadAssistantMessageComponent();
        const userClass = await loadUserMessageComponent();
        const assistantPrototype = verifiedRenderPrototype(
            assistantClass.prototype,
            "AssistantMessageComponent",
        );
        const userPrototype = verifiedRenderPrototype(userClass.prototype, "UserMessageComponent");
        const originalAssistantRender = assistantPrototype.render;
        const originalAssistantUpdateContent = assistantPrototype.updateContent;
        const originalUserRender = userPrototype.render;
        const originalEditorRender = Object.getOwnPropertyDescriptor(Editor.prototype, "render");
        const originalMarkdownRender = Object.getOwnPropertyDescriptor(
            Markdown.prototype,
            "render",
        );

        for (let cycle = 0; cycle < 2; cycle += 1) {
            const responseLifecycle = createLifecycleApi();
            const plainLifecycle = createLifecycleApi();
            const highlightsLifecycle = createLifecycleApi();
            const shutdown = (): void => {
                for (const handler of responseLifecycle.shutdownHandlers) handler();

                for (const handler of plainLifecycle.shutdownHandlers) handler();

                for (const handler of highlightsLifecycle.shutdownHandlers) handler();
            };

            try {
                await responseRendererExtension(responseLifecycle.api);
                await plainUserMessagesExtension(plainLifecycle.api);
                const targets = await loadMessageHighlightTargets();
                assert.ok(targets);
                const patch = installMessageHighlightPatch(
                    targets,
                    DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
                    () => ({
                        fg: (_color, text) => `${ESC}[38;2;135;215;255m${text}${ESC}[39m`,
                        getColorMode: () => "truecolor",
                    }),
                );
                highlightsLifecycle.shutdownHandlers.push(() => patch.dispose());
                restoreInitializedTheme ??= await initializePiTheme();

                const AssistantMessageComponent = assistantClass;
                const UserMessageComponent = userClass;
                const message = {
                    role: "assistant",
                    content: [{ type: "text", text: "Read https://example.com/docs now" }],
                    api: "openai-responses",
                    provider: "openai",
                    model: "gpt-5",
                    usage: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 0,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    },
                    stopReason: "stop",
                    timestamp: 0,
                } satisfies AssistantMessage;
                const assistant = new AssistantMessageComponent(
                    message,
                    false,
                    markdownTheme,
                    "Thinking",
                    0,
                );
                const user = new UserMessageComponent(
                    "Open https://example.com/account",
                    markdownTheme,
                    0,
                );
                const editor = new Editor(new TuiMainScreen(new FakeTerminal()), editorTheme);
                editor.setText("Visit https://example.com/settings");

                const assistantRaw = assistant.render(80).join("\n");
                const userRaw = user.render(80).join("\n");
                const editorRaw = editor.render(80).join("\n");
                const urlHighlight = new RegExp(`${ESC}\\[38;(?:2;135;215;255|5;\\d+)m`);
                assert.match(assistantRaw, urlHighlight);
                assert.match(userRaw, urlHighlight);
                assert.match(editorRaw, urlHighlight);
                assert.match(
                    stripTerminalSequences(assistantRaw),
                    /Read https:\/\/example\.com\/docs now/,
                );
                assert.match(
                    stripTerminalSequences(userRaw),
                    /Open https:\/\/example\.com\/account/,
                );
                assert.match(
                    stripTerminalSequences(editorRaw),
                    /Visit https:\/\/example\.com\/settings/,
                );
                assert.notEqual(assistantPrototype.render, originalAssistantRender);
                assert.notEqual(userPrototype.render, originalUserRender);
            } finally {
                shutdown();
            }

            assert.equal(assistantPrototype.render, originalAssistantRender);
            assert.equal(assistantPrototype.updateContent, originalAssistantUpdateContent);
            assert.equal(userPrototype.render, originalUserRender);
            assert.deepEqual(
                Object.getOwnPropertyDescriptor(Editor.prototype, "render"),
                originalEditorRender,
            );
            assert.deepEqual(
                Object.getOwnPropertyDescriptor(Markdown.prototype, "render"),
                originalMarkdownRender,
            );
        }
    } finally {
        restoreInitializedTheme?.();
        restoreOriginalTheme();

        if (originalPiFlag === undefined) delete process.env.PI_CODING_AGENT;
        else process.env.PI_CODING_AGENT = originalPiFlag;
    }
});
