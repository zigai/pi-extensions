import assert from "node:assert/strict";
import { describe, it } from "vitest";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
    TuiMainScreen as TUI,
    type EditorComponent,
    type EditorTheme,
    type Terminal,
} from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import {
    applyKeymapEditor,
    type EditorFactory,
    type KeymapEditorContext,
} from "../src/editor-keymap.ts";
import type { KeymapTweaksConfig } from "../src/settings-input.ts";
import {
    cycleThinkingLevelBackward,
    isThinkingBackwardKeyMatch,
    matchesKeyChord,
} from "../src/thinking-cycle.ts";

class FakeTerminal implements Terminal {
    columns = 80;
    rows = 24;

    get kittyProtocolActive(): boolean {
        return false;
    }

    start(): void {}

    stop(): void {}

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
}

const identityStyle = (text: string): string => text;
const editorTheme: EditorTheme = {
    borderColor: identityStyle,
    selectList: {
        selectedPrefix: identityStyle,
        selectedText: identityStyle,
        description: identityStyle,
        scrollInfo: identityStyle,
        noMatch: identityStyle,
    },
};

function createFakeModel(
    options: {
        readonly reasoning?: boolean;
        readonly thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
    } = {},
): Model<Api> {
    return {
        id: "test-model",
        name: "Test Model",
        api: "openai",
        provider: "test-provider",
        baseUrl: "https://example.com",
        reasoning: options.reasoning ?? true,
        thinkingLevelMap: options.thinkingLevelMap ?? {
            off: "off",
            low: "low",
            medium: "medium",
            high: "high",
        },
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
    };
}

function createTestKeymapEditor(
    options: {
        readonly getSettings?: () => KeymapTweaksConfig;
        readonly getModel?: () => Model<Api> | undefined;
        readonly getThinkingLevel?: () => ThinkingLevel | undefined;
        readonly setThinkingLevel?: (level: ThinkingLevel) => void;
        readonly notify?: (message: string, type?: "info" | "warning" | "error") => void;
        readonly keybindings?: KeybindingsManager;
    } = {},
): EditorComponent {
    let editorFactory: EditorFactory | undefined;
    const context = {
        hasUI: true,
        ui: {
            getEditorComponent() {
                return editorFactory;
            },
            setEditorComponent(nextFactory: EditorFactory | undefined): void {
                editorFactory = nextFactory;
            },
        },
    } satisfies KeymapEditorContext;

    applyKeymapEditor(context, options);

    if (editorFactory === undefined) {
        assert.fail("expected editor factory");
    }

    const tui = new TUI(new FakeTerminal());
    return editorFactory(tui, editorTheme, options.keybindings ?? new KeybindingsManager());
}

describe("cycleThinkingLevelBackward", () => {
    it("returns undefined when model does not support reasoning", () => {
        const nonReasoningModel = createFakeModel({ reasoning: false });
        let updatedLevel: ThinkingLevel | undefined;
        const result = cycleThinkingLevelBackward(nonReasoningModel, "high", (level) => {
            updatedLevel = level;
        });

        assert.equal(result, undefined);
        assert.equal(updatedLevel, undefined);
    });

    it("cycles backward through supported thinking levels", () => {
        const model = createFakeModel();
        const setCalls: ThinkingLevel[] = [];
        const setter = (level: ThinkingLevel): void => {
            setCalls.push(level);
        };

        const step1 = cycleThinkingLevelBackward(model, "high", setter);
        assert.equal(step1, "medium");
        const step2 = cycleThinkingLevelBackward(model, "medium", setter);
        assert.equal(step2, "low");
        const step3 = cycleThinkingLevelBackward(model, "low", setter);
        assert.equal(step3, "minimal");
        const step4 = cycleThinkingLevelBackward(model, "minimal", setter);
        assert.equal(step4, "off");
        const step5 = cycleThinkingLevelBackward(model, "off", setter);
        assert.equal(step5, "high");
        const step6 = cycleThinkingLevelBackward(model, undefined, setter);
        assert.equal(step6, "high");
        assert.deepEqual(setCalls, ["medium", "low", "minimal", "off", "high", "high"]);
    });
});

describe("matchesKeyChord and isThinkingBackwardKeyMatch", () => {
    it("matches alt+shift+tab with legacy and modern escape sequences", () => {
        assert.equal(matchesKeyChord("\x1b\x1b[Z", "alt+shift+tab"), true);
        assert.equal(matchesKeyChord("\x1b[1;3Z", "alt+shift+tab"), true);
        assert.equal(matchesKeyChord("\x1b[9;4u", "alt+shift+tab"), true);
        assert.equal(matchesKeyChord("a", "alt+shift+tab"), false);
    });

    it("matches configured key when provided", () => {
        assert.equal(isThinkingBackwardKeyMatch("\x1b\x1b[Z", "alt+shift+tab", undefined), true);
        assert.equal(isThinkingBackwardKeyMatch("x", "alt+shift+tab", undefined), false);
        assert.equal(isThinkingBackwardKeyMatch("\x1b\x1b[Z", null, undefined), false);
    });

    it("matches user keybinding array or string", () => {
        assert.equal(isThinkingBackwardKeyMatch("\x1b\x1b[Z", null, ["alt+shift+tab"]), true);
        assert.equal(isThinkingBackwardKeyMatch("\x1b\x1b[Z", null, "alt+shift+tab"), true);
        assert.equal(isThinkingBackwardKeyMatch("x", null, ["alt+shift+tab"]), false);
    });
});

describe("editor integration with backward thinking cycle", () => {
    it("cycles backward when configured via settings", () => {
        let currentLevel: ThinkingLevel = "high";
        const setCalls: ThinkingLevel[] = [];
        const model = createFakeModel();
        const notifications: string[] = [];

        const editor = createTestKeymapEditor({
            getSettings: () => ({ cycleThinkingBackwardKey: "alt+shift+tab" }),
            getModel: () => model,
            getThinkingLevel: () => currentLevel,
            setThinkingLevel: (lvl) => {
                currentLevel = lvl;
                setCalls.push(lvl);
            },
            notify: (msg) => {
                notifications.push(msg);
            },
        });

        editor.render(80);
        editor.handleInput("\x1b\x1b[Z");
        assert.deepEqual(setCalls, ["medium"]);
        assert.equal(currentLevel, "medium");
        editor.handleInput("\x1b\x1b[Z");
        assert.deepEqual(setCalls, ["medium", "low"]);
        assert.equal(currentLevel, "low");
        assert.equal(notifications.length, 0);
    });

    it("cycles backward when configured via keybindings action", () => {
        let currentLevel: ThinkingLevel = "low";
        const setCalls: ThinkingLevel[] = [];
        const model = createFakeModel();
        const keybindings = new KeybindingsManager({
            "app.thinking.cycleBackward": ["alt+shift+tab"],
        });

        const editor = createTestKeymapEditor({
            getSettings: () => ({ cycleThinkingBackwardKey: null }),
            getModel: () => model,
            getThinkingLevel: () => currentLevel,
            setThinkingLevel: (lvl) => {
                currentLevel = lvl;
                setCalls.push(lvl);
            },
            keybindings,
        });

        editor.render(80);
        editor.handleInput("\x1b\x1b[Z");
        assert.deepEqual(setCalls, ["minimal"]);
        assert.equal(currentLevel, "minimal");
    });

    it("does not cycle when unbound", () => {
        const setCalls: ThinkingLevel[] = [];
        const editor = createTestKeymapEditor({
            getSettings: () => ({ cycleThinkingBackwardKey: null }),
            getModel: () => createFakeModel(),
            getThinkingLevel: () => "high",
            setThinkingLevel: (lvl) => {
                setCalls.push(lvl);
            },
        });

        editor.render(80);
        editor.handleInput("\x1b\x1b[Z");
        assert.deepEqual(setCalls, []);
    });
});
