import { installLinkedMethodPatch } from "@zigai/pi-extension-internals";
import { Loader, visibleWidth } from "@earendil-works/pi-tui";

import { getRightMessageMinGap, renderRightMessage } from "./right-message.ts";
import {
    getStatusBarSnapshot,
    subscribeStatusBarUpdates,
    type StatusBarSnapshot,
} from "./status-bar-api.ts";

const LOADER_TIME_PATCH_CONTROLLER_KEY = Symbol.for(
    "zigai.pi-status-bar.loader-time-patch-controller",
);
const LOADER_TIME_PATCH_VERSION = 6;
const MIN_VISIBLE_RIGHT_MESSAGE_WIDTH = 4;
const STATIC_LOADER_REFRESH_INTERVAL_MS = 1_000;

type LoaderMethod = (this: Loader) => void;
type LoaderRenderMethod = (this: Loader, width: number) => string[];

type LoaderPrototype = {
    start: LoaderMethod;
    stop: LoaderMethod;
    updateDisplay: LoaderMethod;
    render: LoaderRenderMethod;
};

type LoaderPatchController = {
    readonly version: number;
    acquire(): () => void;
};

type PatchState = typeof globalThis & {
    [LOADER_TIME_PATCH_CONTROLLER_KEY]?: LoaderPatchController;
};

type LoaderDisplay = {
    readonly leftText: string;
    readonly messageColorFn: (text: string) => string;
    readonly startedAt: number;
    readonly runTimer?: LoaderTimer;
};

type LoaderTimer = {
    startedAt: number;
    accumulatedPausedMs: number;
    resetVersion: number;
    pausedAt?: number;
};

type LoaderElapsed = {
    readonly elapsedMs: number;
    readonly startedAt: number;
};

type LoaderOwner = {
    readonly frames: readonly string[];
    readonly currentFrame: number;
    readonly renderIndicatorVerbatim: boolean;
    readonly spinnerColorFn: (text: string) => string;
    readonly message: string;
    readonly messageColorFn: (text: string) => string;
    readonly setText: (text: string) => void;
    readonly updateDisplay: () => void;
    readonly paddingX: number;
};

type LoaderBoundary = Loader | LoaderOwner;
type LoaderPrototypeBoundary = Loader | LoaderPrototype;

function isLoaderOwner(value: unknown): value is LoaderOwner {
    if (typeof value !== "object" || value === null) return false;
    if (!("frames" in value) || !Array.isArray(value.frames)) return false;

    for (const frame of value.frames) {
        if (typeof frame !== "string") return false;
    }

    return (
        "currentFrame" in value &&
        typeof value.currentFrame === "number" &&
        "renderIndicatorVerbatim" in value &&
        typeof value.renderIndicatorVerbatim === "boolean" &&
        "spinnerColorFn" in value &&
        typeof value.spinnerColorFn === "function" &&
        "message" in value &&
        typeof value.message === "string" &&
        "messageColorFn" in value &&
        typeof value.messageColorFn === "function" &&
        "setText" in value &&
        typeof value.setText === "function" &&
        "updateDisplay" in value &&
        typeof value.updateDisplay === "function" &&
        "paddingX" in value &&
        typeof value.paddingX === "number" &&
        Number.isFinite(value.paddingX) &&
        value.paddingX >= 0
    );
}

function parseLoaderOwner(value: LoaderBoundary): LoaderOwner | undefined {
    if (!isLoaderOwner(value)) return undefined;

    return {
        frames: value.frames,
        currentFrame: value.currentFrame,
        renderIndicatorVerbatim: value.renderIndicatorVerbatim,
        spinnerColorFn: (text) => value.spinnerColorFn(text),
        message: value.message,
        messageColorFn: (text) => value.messageColorFn(text),
        setText: (text) => value.setText(text),
        updateDisplay: () => value.updateDisplay(),
        paddingX: value.paddingX,
    };
}

function isLoaderPrototype(value: unknown): value is LoaderPrototype {
    return (
        typeof value === "object" &&
        value !== null &&
        "start" in value &&
        typeof value.start === "function" &&
        "stop" in value &&
        typeof value.stop === "function" &&
        "updateDisplay" in value &&
        typeof value.updateDisplay === "function" &&
        "render" in value &&
        typeof value.render === "function"
    );
}

function parseLoaderPrototype(value: LoaderPrototypeBoundary): LoaderPrototype | undefined {
    if (!isLoaderPrototype(value)) return undefined;
    return value;
}

function getPatchState(): PatchState {
    return globalThis;
}

const loaderTimers = new WeakMap<object, LoaderTimer>();
let runTimer: LoaderTimer | undefined;
const loaderDisplays = new WeakMap<object, LoaderDisplay>();
const activeLoaders = new Set<Loader>();
let activeLoaderRefreshInterval: ReturnType<typeof setInterval> | undefined;

function getLoaderTimer(loader: Loader, now: number): LoaderTimer {
    let timer = loaderTimers.get(loader);
    if (timer === undefined) {
        timer = {
            startedAt: now,
            accumulatedPausedMs: 0,
            resetVersion: getStatusBarSnapshot().active.timerResetVersion,
        };
        loaderTimers.set(loader, timer);
    }

    return timer;
}

function updateTimer(
    timer: LoaderTimer,
    active: StatusBarSnapshot["active"],
    now: number,
): LoaderElapsed {
    if (timer.resetVersion !== active.timerResetVersion) {
        timer.startedAt = now;
        timer.accumulatedPausedMs = 0;
        delete timer.pausedAt;
        timer.resetVersion = active.timerResetVersion;
    }

    if (active.timerPaused) {
        timer.pausedAt ??= now;
    } else if (timer.pausedAt !== undefined) {
        timer.accumulatedPausedMs += Math.max(0, now - timer.pausedAt);
        delete timer.pausedAt;
    }

    const effectiveNow = timer.pausedAt ?? now;
    return {
        elapsedMs: Math.max(0, effectiveNow - timer.startedAt - timer.accumulatedPausedMs),
        startedAt: timer.startedAt + timer.accumulatedPausedMs,
    };
}

function getElapsedMs(loader: Loader, now: number): LoaderElapsed {
    if ("kind" in loader && loader.kind === "working" && runTimer !== undefined) {
        return updateTimer(runTimer, getStatusBarSnapshot().active, now);
    }

    return updateTimer(getLoaderTimer(loader, now), getStatusBarSnapshot().active, now);
}

function formatElapsed(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainingSeconds}s`;
}

function applyStatusBarDisplay(loader: Loader): void {
    const internals = parseLoaderOwner(loader);
    if (internals === undefined) return;

    const snapshot = getStatusBarSnapshot();
    const frames = snapshot.active.spinnerFrames ?? internals.frames;
    const frame = frames[internals.currentFrame % Math.max(1, frames.length)] ?? "";
    let renderedFrame = internals.spinnerColorFn(frame);
    if (internals.renderIndicatorVerbatim) renderedFrame = frame;

    let indicator = "";
    if (frame.length > 0) indicator = `${renderedFrame} `;

    const now = Date.now();
    const elapsed = getElapsedMs(loader, now);
    const baseMessage = snapshot.active.text ?? internals.message;
    let message = baseMessage;
    if (snapshot.active.timerVisible) {
        message = `${baseMessage} (${formatElapsed(Math.floor(elapsed.elapsedMs / 1000))})`;
    }

    const leftText = `${indicator}${internals.messageColorFn(message)}`;
    let displayedRunTimer: LoaderTimer | undefined;
    if ("kind" in loader && loader.kind === "working") displayedRunTimer = runTimer;

    loaderDisplays.set(loader, {
        leftText,
        messageColorFn: (text: string) => internals.messageColorFn(text),
        startedAt: elapsed.startedAt,
        runTimer: displayedRunTimer,
    });

    internals.setText(leftText);
}

function renderDisplay(
    loader: Loader,
    display: LoaderDisplay,
    width: number,
    predecessor: LoaderRenderMethod,
): string[] {
    if (width <= 0) return predecessor.call(loader, width);

    const internals = parseLoaderOwner(loader);
    if (internals === undefined) return predecessor.call(loader, width);

    let paddingX = Math.floor(internals.paddingX);
    paddingX = Math.min(paddingX, Math.max(0, Math.floor((width - 1) / 2)));

    const contentWidth = Math.max(1, width - paddingX * 2);
    const leftWidth = visibleWidth(display.leftText);
    const minGap = getRightMessageMinGap();
    const availableRightWidth = contentWidth - leftWidth - minGap;
    if (availableRightWidth < MIN_VISIBLE_RIGHT_MESSAGE_WIDTH) {
        return predecessor.call(loader, width);
    }

    const right = renderRightMessage(
        Math.max(0, Date.now() - display.startedAt),
        availableRightWidth,
        display.messageColorFn,
    );
    if (right === undefined) return predecessor.call(loader, width);

    const gapWidth = Math.max(minGap, contentWidth - leftWidth - right.width);
    const content = `${display.leftText}${" ".repeat(gapWidth)}${right.text}`;
    const lineWithPadding = `${" ".repeat(paddingX)}${content}`;
    return [
        "",
        `${lineWithPadding}${" ".repeat(Math.max(0, width - visibleWidth(lineWithPadding)))}`,
    ];
}

function requestLoaderUpdate(loader: Loader): void {
    parseLoaderOwner(loader)?.updateDisplay();
}

function requestActiveLoaderRenders(): void {
    if (runTimer !== undefined) {
        updateTimer(runTimer, getStatusBarSnapshot().active, Date.now());
    }

    for (const loader of activeLoaders) requestLoaderUpdate(loader);
}

export function setStatusBarRunTimer(startedAt: number | undefined): void {
    if (startedAt === undefined) {
        runTimer = undefined;
    } else {
        runTimer = {
            startedAt,
            accumulatedPausedMs: 0,
            resetVersion: getStatusBarSnapshot().active.timerResetVersion,
        };
    }

    requestActiveLoaderRenders();
}

function clearActiveLoaderRefreshInterval(): void {
    if (activeLoaderRefreshInterval === undefined) return;

    clearInterval(activeLoaderRefreshInterval);
    activeLoaderRefreshInterval = undefined;
}

function updateActiveLoaderRefreshInterval(): void {
    if (activeLoaders.size === 0) {
        clearActiveLoaderRefreshInterval();
        return;
    }

    if (activeLoaderRefreshInterval !== undefined) return;

    activeLoaderRefreshInterval = setInterval(
        requestActiveLoaderRenders,
        STATIC_LOADER_REFRESH_INTERVAL_MS,
    );
    activeLoaderRefreshInterval.unref();
}

export function installLoaderPatch(): () => void {
    const state = getPatchState();
    const existingController = state[LOADER_TIME_PATCH_CONTROLLER_KEY];
    if (existingController?.version === LOADER_TIME_PATCH_VERSION) {
        return existingController.acquire();
    }

    const prototype = parseLoaderPrototype(Loader.prototype);
    if (prototype === undefined) return () => {};

    let active = false;
    let leaseCount = 0;
    let unsubscribeStatusBarUpdates: (() => void) | undefined;

    const startPatch = installLinkedMethodPatch(
        prototype,
        "start",
        (predecessor) =>
            function patchedStart(this: Loader): void {
                if (!active) {
                    predecessor.call(this);
                    return;
                }

                const existingTimer = loaderTimers.get(this);
                const startedAt = Date.now();

                predecessor.call(this);
                activeLoaders.add(this);
                loaderTimers.set(
                    this,
                    existingTimer ?? {
                        startedAt,
                        accumulatedPausedMs: 0,
                        resetVersion: getStatusBarSnapshot().active.timerResetVersion,
                    },
                );

                updateActiveLoaderRefreshInterval();
                requestLoaderUpdate(this);
            },
    );
    const stopPatch = installLinkedMethodPatch(
        prototype,
        "stop",
        (predecessor) =>
            function patchedStop(this: Loader): void {
                try {
                    predecessor.call(this);
                } finally {
                    activeLoaders.delete(this);
                    loaderTimers.delete(this);
                    loaderDisplays.delete(this);
                    updateActiveLoaderRefreshInterval();
                }
            },
    );
    const updatePatch = installLinkedMethodPatch(
        prototype,
        "updateDisplay",
        (predecessor) =>
            function patchedUpdateDisplay(this: Loader): void {
                predecessor.call(this);

                if (active && activeLoaders.has(this)) applyStatusBarDisplay(this);
            },
    );
    const renderPatch = installLinkedMethodPatch(
        prototype,
        "render",
        (predecessor) =>
            function patchedRender(this: Loader, width: number): string[] {
                if (!active) return predecessor.call(this, width);

                let display = loaderDisplays.get(this);
                if (
                    runTimer !== undefined &&
                    "kind" in this &&
                    this.kind === "working" &&
                    display?.runTimer !== runTimer
                ) {
                    applyStatusBarDisplay(this);
                    display = loaderDisplays.get(this);
                }

                if (display === undefined) return predecessor.call(this, width);
                return renderDisplay(this, display, width, predecessor);
            },
    );

    const controller: LoaderPatchController = {
        version: LOADER_TIME_PATCH_VERSION,
        acquire(): () => void {
            leaseCount += 1;

            if (!active) {
                active = true;
                unsubscribeStatusBarUpdates ??= subscribeStatusBarUpdates(
                    requestActiveLoaderRenders,
                );
            }

            let released = false;
            return () => {
                if (released) return;

                released = true;
                leaseCount = Math.max(0, leaseCount - 1);
                if (leaseCount > 0 || !active) return;

                active = false;
                unsubscribeStatusBarUpdates?.();
                unsubscribeStatusBarUpdates = undefined;
                clearActiveLoaderRefreshInterval();

                const loaders = [...activeLoaders];

                activeLoaders.clear();

                for (const loader of loaders) {
                    loaderTimers.delete(loader);
                    loaderDisplays.delete(loader);
                }

                renderPatch.dispose();
                updatePatch.dispose();
                stopPatch.dispose();
                startPatch.dispose();

                for (const loader of loaders) requestLoaderUpdate(loader);

                if (state[LOADER_TIME_PATCH_CONTROLLER_KEY] === controller) {
                    delete state[LOADER_TIME_PATCH_CONTROLLER_KEY];
                }
            };
        },
    };

    state[LOADER_TIME_PATCH_CONTROLLER_KEY] = controller;
    return controller.acquire();
}
