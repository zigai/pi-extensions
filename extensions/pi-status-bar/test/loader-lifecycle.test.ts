import assert from "node:assert/strict";
import { afterEach, beforeAll, beforeEach, describe, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Loader, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";

import { FakeTerminal, RenderCountingTui } from "./tui-fixture.ts";

import statusBarExtension from "../src/index.ts";
import {
    configureStatusBar,
    registerStatusBarSegment,
    resetStatusBarStateForTests,
} from "../src/status-bar-api.ts";

type LoaderUpdateDisplay = (this: Loader) => void;

type LoaderPrototypeOwner = {
    updateDisplay: LoaderUpdateDisplay;
};
type LoaderPrototypeBoundary = Loader | LoaderPrototypeOwner;

type TuiInternals = {
    doRender(): void;
    previousLines: string[];
};
type LoaderFixture = {
    readonly loader: Loader;
    readonly renderCount: () => number;
};

function isTuiInternals(value: unknown): value is TuiInternals {
    if (
        typeof value !== "object" ||
        value === null ||
        !("doRender" in value) ||
        typeof value.doRender !== "function" ||
        !("previousLines" in value) ||
        !Array.isArray(value.previousLines)
    ) {
        return false;
    }

    for (const line of value.previousLines) {
        if (typeof line !== "string") return false;
    }

    return true;
}

function isLoaderPrototypeOwner(value: unknown): value is LoaderPrototypeOwner {
    return (
        typeof value === "object" &&
        value !== null &&
        "updateDisplay" in value &&
        typeof value.updateDisplay === "function"
    );
}

function parseLoaderPrototypeOwner(
    value: LoaderPrototypeBoundary,
): LoaderPrototypeOwner | undefined {
    if (!isLoaderPrototypeOwner(value)) return undefined;
    return value;
}

function getTuiInternals(tui: TuiMainScreen): TuiInternals {
    if (!isTuiInternals(tui)) throw new Error("Expected TUI render internals");
    return tui;
}

let predecessorUpdateCount = 0;

function getLoaderPrototype(): LoaderPrototypeOwner {
    const prototype = parseLoaderPrototypeOwner(Loader.prototype);
    if (prototype === undefined) {
        throw new Error("Expected Loader.updateDisplay to be callable");
    }

    return prototype;
}

function createExtensionApi(): Pick<ExtensionAPI, "on" | "appendEntry"> {
    const api: Pick<ExtensionAPI, "on" | "appendEntry"> = {
        appendEntry(): void {},
        on(): () => void {
            return () => {};
        },
    };

    return api;
}

function createLoader(frames: string[] = ["⠙"]): LoaderFixture {
    const ui = new RenderCountingTui();
    const loader = new Loader(
        ui,
        (text) => text,
        (text) => text,
        "Working...",
        {
            frames,
        },
    );

    return { loader, renderCount: () => ui.renderRequests };
}

function visibleLoaderLines(loader: Loader): string[] {
    return loader.render(80).map((line) => line.trimEnd());
}

beforeAll(() => {
    resetStatusBarStateForTests();
    const prototype = getLoaderPrototype();
    const originalUpdateDisplay = prototype.updateDisplay;
    prototype.updateDisplay = function precedingUpdate(this: Loader): void {
        predecessorUpdateCount += 1;
        originalUpdateDisplay.call(this);
    };
    statusBarExtension(createExtensionApi());
});

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    configureStatusBar({}).dispose();
    predecessorUpdateCount = 0;
});

afterEach(() => {
    vi.useRealTimers();
});

describe("status loader lifecycle", () => {
    test("keeps a static indicator timer advancing", () => {
        const { loader, renderCount } = createLoader();
        assert.deepEqual(visibleLoaderLines(loader), ["", " ⠙ Working... (0s)"]);
        const initialRenderCount = renderCount();

        vi.advanceTimersByTime(1_100);
        assert.deepEqual(visibleLoaderLines(loader), ["", " ⠙ Working... (1s)"]);
        assert.ok(renderCount() > initialRenderCount);
        loader.stop();
        const stoppedRenderCount = renderCount();
        vi.advanceTimersByTime(2_000);
        assert.equal(renderCount(), stoppedRenderCount);
    });

    test("preserves elapsed time when another extension changes the indicator", () => {
        const { loader } = createLoader();
        vi.advanceTimersByTime(2_100);
        assert.deepEqual(visibleLoaderLines(loader), ["", " ⠙ Working... (2s)"]);
        loader.setIndicator({ frames: ["■"] });
        assert.deepEqual(visibleLoaderLines(loader), ["", " ■ Working... (2s)"]);
        vi.advanceTimersByTime(1_000);
        assert.deepEqual(visibleLoaderLines(loader), ["", " ■ Working... (3s)"]);
        loader.stop();
    });

    test("composes with update wrappers installed before and after it", () => {
        const { loader } = createLoader();
        assert.ok(predecessorUpdateCount > 0);
        const prototype = getLoaderPrototype();
        const statusBarUpdateDisplay = prototype.updateDisplay;
        let laterUpdateCount = 0;
        prototype.updateDisplay = function laterUpdate(this: Loader): void {
            laterUpdateCount += 1;
            statusBarUpdateDisplay.call(this);
        };

        try {
            configureStatusBar({ active: { text: "Coordinating" } });
            assert.equal(laterUpdateCount, 1);
            assert.deepEqual(visibleLoaderLines(loader), ["", " ⠙ Coordinating (0s)"]);
        } finally {
            prototype.updateDisplay = statusBarUpdateDisplay;
            loader.stop();
        }
    });

    test("shares the active line with extension segments across resizes", () => {
        const segment = registerStatusBarSegment({
            id: "other-extension.progress",
            states: ["active"],
            text: "reviewing",
        });
        const { loader } = createLoader();

        const wideLine = loader.render(48)[1] ?? "";
        assert.match(wideLine, /Working\.\.\. \(0s\)/);
        assert.match(wideLine, /reviewing/);
        assert.ok(visibleWidth(wideLine) <= 48);
        const narrowLine = loader.render(16)[1] ?? "";
        assert.doesNotMatch(narrowLine, /reviewing/);
        assert.ok(visibleWidth(narrowLine) <= 16);
        segment.dispose();
        loader.stop();
    });

    test("renders active composition and resize truncation onto a real terminal screen", () => {
        configureStatusBar({ active: { text: "Coordinating" } });
        const segment = registerStatusBarSegment({
            id: "other-extension.screen-progress",
            states: ["active"],
            text: "reviewing",
        });
        const terminal = new FakeTerminal();
        const tui = new TuiMainScreen(terminal);
        const loader = new Loader(
            tui,
            (text) => text,
            (text) => text,
            "Working...",
            { frames: ["●"] },
        );
        const internals = getTuiInternals(tui);
        tui.addChild(loader);

        try {
            terminal.writes = [];
            internals.doRender();
            const wideTerminalWrites = terminal.writes.join("");
            assert.match(wideTerminalWrites, /● Coordinating \(0s\).*reviewing/);
            assert.ok(internals.previousLines.every((line) => visibleWidth(line) <= 48));
            terminal.columns = 18;
            terminal.writes = [];
            internals.doRender();
            const narrowTerminalWrites = terminal.writes.join("");
            assert.match(narrowTerminalWrites, /● Coordinat/);
            assert.doesNotMatch(narrowTerminalWrites, /reviewing/);
            assert.ok(internals.previousLines.every((line) => visibleWidth(line) <= 18));
        } finally {
            segment.dispose();
            loader.stop();
            tui.stop();
        }
    });
});
