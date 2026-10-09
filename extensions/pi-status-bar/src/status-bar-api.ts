import { visibleWidth } from "@earendil-works/pi-tui";

const STATUS_BAR_STATE = Symbol.for("zigai.pi-status-bar.status-bar-state.v1");
const CUSTOM_SEGMENT_ID_PATTERN = "^[a-zA-Z0-9_-]+(?:[.][a-zA-Z0-9_-]+)+$";
const CUSTOM_SEGMENT_ID_REGEX = new RegExp(CUSTOM_SEGMENT_ID_PATTERN);

export type StatusBarStateName = "active" | "idle";
export type StatusBarSide = "right";

export type StatusBarSpinnerConfig = {
    /** Frames used instead of Pi's current loader frames while active. */
    readonly frames?: readonly string[];
};

export type StatusBarTimerConfig = {
    /** Whether the active elapsed timer is visible. */
    readonly visible?: boolean;

    /** Whether the active elapsed timer is paused. */
    readonly paused?: boolean;
};

export type StatusBarActiveConfig = {
    /** Text used instead of Pi's active loader message. */
    readonly text?: string;

    /** Active spinner override. */
    readonly spinner?: StatusBarSpinnerConfig;

    /** Active timer override. */
    readonly timer?: StatusBarTimerConfig;
};

export type StatusBarIdleConfig = {
    /** Text used instead of the default post-run summary. */
    readonly text?: string;

    /** Whether the idle status bar widget is visible. */
    readonly visible?: boolean;

    /** Whether to append the default last-run summary after custom idle text. */
    readonly showLastRunSummary?: boolean;

    /** Whether to include model token throughput in the last-run summary. */
    readonly showTokensPerSecond?: boolean;
};

export type StatusBarConfig = {
    readonly active?: StatusBarActiveConfig;
    readonly idle?: StatusBarIdleConfig;
};

export type StatusBarHandle = {
    /** Replace the active working text. Empty text clears the override. */
    setActiveText(text: string): void;

    /** Replace the idle status text. Empty text clears the override. */
    setIdleText(text: string): void;

    /** Replace active spinner frames. Empty frames clear the override. */
    setSpinner(spinner: StatusBarSpinnerConfig): void;

    /** Pause the active elapsed timer. */
    pauseTimer(): void;

    /** Resume the active elapsed timer. */
    resumeTimer(): void;

    /** Reset the active elapsed timer baseline. */
    resetTimer(): void;

    /** Hide the active elapsed timer. */
    hideTimer(): void;

    /** Show the active elapsed timer. */
    showTimer(): void;

    /** Clear this handle's status-bar override while keeping the handle alive. */
    clear(): void;

    /** Remove this status-bar override. Stale handles become inert after disposal. */
    dispose(): void;
};

export type StatusBarSegmentRegistration = {
    /** Namespaced custom segment id, for example `my-extension.status`. */
    readonly id: string;

    /** Lifecycle states where the segment should render. Defaults to both states. */
    readonly states?: readonly StatusBarStateName[];

    /** Side where the segment should render. Currently only `right` is supported. */
    readonly side?: StatusBarSide;

    /** Initial visible text. Empty or whitespace-only text hides the segment. */
    readonly text?: string;

    /** Lower values render first. Defaults to 100. */
    readonly priority?: number;

    /** Render the segment dimmed. */
    readonly dimmed?: boolean;

    /** Render the segment italic. */
    readonly italic?: boolean;
};

export type StatusBarSegmentHandle = {
    /** Replace this segment's visible text. Empty text hides the segment. */
    setText(text: string): void;

    /** Hide this segment while keeping its registration. */
    clear(): void;

    /** Remove this segment registration. Stale handles become inert after disposal. */
    dispose(): void;
};

export type StatusBarSegmentSnapshot = {
    readonly id: string;
    readonly states: readonly StatusBarStateName[];
    readonly side: StatusBarSide;
    readonly text: string;
    readonly priority: number;
    readonly dimmed: boolean;
    readonly italic: boolean;
};

export type StatusBarSnapshot = {
    readonly active: {
        readonly text?: string;
        readonly spinnerFrames?: readonly string[];
        readonly timerVisible: boolean;
        readonly timerPaused: boolean;
        readonly timerResetVersion: number;
    };

    readonly idle: {
        readonly text?: string;
        readonly visible: boolean;
        readonly showLastRunSummary: boolean;
        readonly showTokensPerSecond: boolean;
    };

    readonly segments: readonly StatusBarSegmentSnapshot[];
};

type MutableStatusBarOverride = {
    readonly owner: symbol;
    activeText?: string;
    spinnerFrames?: readonly string[];
    timerVisible?: boolean;
    timerPaused?: boolean;
    idleText?: string;
    idleVisible?: boolean;
    idleShowLastRunSummary?: boolean;
    idleShowTokensPerSecond?: boolean;
};

type MutableStatusBarSegment = {
    readonly id: string;
    readonly owner: symbol;
    readonly states: readonly StatusBarStateName[];
    readonly side: StatusBarSide;
    readonly priority: number;
    readonly dimmed: boolean;
    readonly italic: boolean;
    text?: string;
};

type StatusBarState = {
    base: MutableStatusBarOverride;
    override?: MutableStatusBarOverride;
    readonly segments: Map<string, MutableStatusBarSegment>;
    readonly listeners: Set<() => void>;
    timerResetVersion: number;
};

type StatusBarGlobal = typeof globalThis & {
    [STATUS_BAR_STATE]?: StatusBarState;
};

// SAFETY: This intersection only adds one optional symbol-keyed slot to the
// existing global object and does not change its runtime representation.
const statusBarGlobal = globalThis as StatusBarGlobal;

function getStatusBarState(): StatusBarState {
    let state = statusBarGlobal[STATUS_BAR_STATE];
    if (state === undefined) {
        state = {
            base: { owner: Symbol("status-bar-base") },
            segments: new Map(),
            listeners: new Set(),
            timerResetVersion: 0,
        };
        statusBarGlobal[STATUS_BAR_STATE] = state;
    }

    return state;
}

function sanitizeText(text: string): string | undefined {
    const sanitized = text
        .replace(/[\r\n\t]/g, " ")
        .replace(/ +/g, " ")
        .trim();
    if (sanitized.length === 0) return undefined;
    return sanitized;
}

function sanitizeFrames(frames: readonly string[] | undefined): readonly string[] | undefined {
    if (frames === undefined) return undefined;

    const sanitizedFrames: string[] = [];
    for (const frame of frames) {
        const sanitized = sanitizeText(frame);
        if (sanitized === undefined) continue;
        if (visibleWidth(sanitized) === 0) continue;
        sanitizedFrames.push(sanitized);
    }

    if (sanitizedFrames.length === 0) return undefined;
    return sanitizedFrames;
}

function parseSegmentId(id: string): string {
    if (CUSTOM_SEGMENT_ID_REGEX.test(id)) return id;
    throw new Error(
        `[pi-status-bar] Status bar segment id "${id}" must be namespaced, for example "my-extension.status".`,
    );
}

function parseStates(states: readonly string[] | undefined): readonly StatusBarStateName[] {
    if (states === undefined) return ["active", "idle"];

    const parsed: StatusBarStateName[] = [];
    for (const state of states) {
        if (state !== "active" && state !== "idle") {
            throw new Error(
                `[pi-status-bar] Status bar segment states must be "active" or "idle".`,
            );
        }

        if (!parsed.includes(state)) {
            parsed.push(state);
        }
    }

    if (parsed.length === 0) return ["active", "idle"];
    return parsed;
}

function parseSide(side: string | undefined): StatusBarSide {
    if (side === undefined || side === "right") return "right";
    throw new Error(`[pi-status-bar] Status bar segment side must be "right".`);
}

function parsePriority(priority: number | undefined): number {
    if (priority === undefined) return 100;
    if (Number.isFinite(priority)) return priority;
    throw new Error(`[pi-status-bar] Status bar segment priority must be a finite number.`);
}

function emitStatusBarUpdates(state: StatusBarState): void {
    const listeners = Array.from(state.listeners);
    const causes: unknown[] = [];

    for (const listener of listeners) {
        try {
            listener();
        } catch (cause: unknown) {
            causes.push(cause);
        }
    }

    if (causes.length === 1) {
        throw causes[0];
    }

    if (causes.length > 1) {
        throw new AggregateError(causes, "Status bar update listeners failed.");
    }
}

function applyStatusBarConfig(target: MutableStatusBarOverride, config: StatusBarConfig): boolean {
    let changed = false;
    let activeText: string | undefined;
    if (config.active?.text !== undefined) {
        activeText = sanitizeText(config.active.text);
    }

    if (target.activeText !== activeText) {
        changed = true;

        if (activeText === undefined) {
            delete target.activeText;
        } else {
            target.activeText = activeText;
        }
    }

    const spinnerFrames = sanitizeFrames(config.active?.spinner?.frames);
    if (target.spinnerFrames !== spinnerFrames) {
        changed = true;

        if (spinnerFrames === undefined) {
            delete target.spinnerFrames;
        } else {
            target.spinnerFrames = spinnerFrames;
        }
    }

    const timerVisible = config.active?.timer?.visible;
    if (target.timerVisible !== timerVisible) {
        changed = true;

        if (timerVisible === undefined) {
            delete target.timerVisible;
        } else {
            target.timerVisible = timerVisible;
        }
    }

    const timerPaused = config.active?.timer?.paused;
    if (target.timerPaused !== timerPaused) {
        changed = true;

        if (timerPaused === undefined) {
            delete target.timerPaused;
        } else {
            target.timerPaused = timerPaused;
        }
    }

    let idleText: string | undefined;
    if (config.idle?.text !== undefined) {
        idleText = sanitizeText(config.idle.text);
    }

    if (target.idleText !== idleText) {
        changed = true;

        if (idleText === undefined) {
            delete target.idleText;
        } else {
            target.idleText = idleText;
        }
    }

    const idleVisible = config.idle?.visible;
    if (target.idleVisible !== idleVisible) {
        changed = true;

        if (idleVisible === undefined) {
            delete target.idleVisible;
        } else {
            target.idleVisible = idleVisible;
        }
    }

    const idleShowLastRunSummary = config.idle?.showLastRunSummary;
    if (target.idleShowLastRunSummary !== idleShowLastRunSummary) {
        changed = true;

        if (idleShowLastRunSummary === undefined) {
            delete target.idleShowLastRunSummary;
        } else {
            target.idleShowLastRunSummary = idleShowLastRunSummary;
        }
    }

    const idleShowTokensPerSecond = config.idle?.showTokensPerSecond;
    if (target.idleShowTokensPerSecond !== idleShowTokensPerSecond) {
        changed = true;

        if (idleShowTokensPerSecond === undefined) {
            delete target.idleShowTokensPerSecond;
        } else {
            target.idleShowTokensPerSecond = idleShowTokensPerSecond;
        }
    }

    return changed;
}

function getOwnedOverride(
    state: StatusBarState,
    owner: symbol,
    disposed: () => boolean,
): MutableStatusBarOverride | undefined {
    if (disposed()) return undefined;
    if (state.override?.owner !== owner) return undefined;
    return state.override;
}

/** Configure the coherent Pi status bar across active and idle lifecycle states. */
export function configureStatusBar(config: StatusBarConfig): StatusBarHandle {
    const state = getStatusBarState();
    const owner = Symbol("status-bar-override");
    const override: MutableStatusBarOverride = { owner };
    applyStatusBarConfig(override, config);
    state.override = override;
    emitStatusBarUpdates(state);

    let disposed = false;
    const isDisposed = (): boolean => disposed;

    function updateOwned(mutator: (override: MutableStatusBarOverride) => boolean): void {
        const current = getOwnedOverride(state, owner, isDisposed);
        if (current === undefined) {
            disposed = true;
            return;
        }

        if (!mutator(current)) return;

        emitStatusBarUpdates(state);
    }

    return {
        setActiveText(text: string): void {
            updateOwned((current) => {
                const nextText = sanitizeText(text);
                if (current.activeText === nextText) return false;

                if (nextText === undefined) {
                    delete current.activeText;
                } else {
                    current.activeText = nextText;
                }

                return true;
            });
        },
        setIdleText(text: string): void {
            updateOwned((current) => {
                const nextText = sanitizeText(text);
                if (current.idleText === nextText) return false;

                if (nextText === undefined) {
                    delete current.idleText;
                } else {
                    current.idleText = nextText;
                }

                return true;
            });
        },
        setSpinner(spinner: StatusBarSpinnerConfig): void {
            updateOwned((current) => {
                const frames = sanitizeFrames(spinner.frames);
                if (current.spinnerFrames === frames) return false;

                if (frames === undefined) {
                    delete current.spinnerFrames;
                } else {
                    current.spinnerFrames = frames;
                }

                return true;
            });
        },
        pauseTimer(): void {
            updateOwned((current) => {
                if (current.timerPaused === true) return false;

                current.timerPaused = true;
                return true;
            });
        },
        resumeTimer(): void {
            updateOwned((current) => {
                if (current.timerPaused === false) return false;

                current.timerPaused = false;
                return true;
            });
        },
        resetTimer(): void {
            const current = getOwnedOverride(state, owner, isDisposed);
            if (current === undefined) {
                disposed = true;
                return;
            }

            state.timerResetVersion += 1;
            emitStatusBarUpdates(state);
        },
        hideTimer(): void {
            updateOwned((current) => {
                if (current.timerVisible === false) return false;

                current.timerVisible = false;
                return true;
            });
        },
        showTimer(): void {
            updateOwned((current) => {
                if (current.timerVisible === true) return false;

                current.timerVisible = true;
                return true;
            });
        },
        clear(): void {
            updateOwned((current) => applyStatusBarConfig(current, {}));
        },
        dispose(): void {
            const current = getOwnedOverride(state, owner, isDisposed);
            disposed = true;

            if (current === undefined) return;

            delete state.override;
            emitStatusBarUpdates(state);
        },
    };
}

/** Set config-backed status-bar defaults. Intended for pi-status-bar internals. */
export function setStatusBarBaseConfig(config: StatusBarConfig): void {
    const state = getStatusBarState();
    if (!applyStatusBarConfig(state.base, config)) return;

    emitStatusBarUpdates(state);
}

/** Register a scriptable status-bar segment for active, idle, or both states. */
export function registerStatusBarSegment(
    registration: StatusBarSegmentRegistration,
): StatusBarSegmentHandle {
    const state = getStatusBarState();
    const id = parseSegmentId(registration.id);
    const owner = Symbol(id);
    const segment: MutableStatusBarSegment = {
        id,
        owner,
        states: parseStates(registration.states),
        side: parseSide(registration.side),
        priority: parsePriority(registration.priority),
        dimmed: registration.dimmed ?? false,
        italic: registration.italic ?? false,
    };

    let text: string | undefined;
    if (registration.text !== undefined) {
        text = sanitizeText(registration.text);
    }

    if (text !== undefined) {
        segment.text = text;
    }

    state.segments.delete(id);
    state.segments.set(id, segment);
    emitStatusBarUpdates(state);

    let disposed = false;

    function getOwnedSegment(): MutableStatusBarSegment | undefined {
        if (disposed) return undefined;

        const current = state.segments.get(id);
        if (current?.owner !== owner) {
            disposed = true;
            return undefined;
        }

        return current;
    }

    return {
        setText(text: string): void {
            const current = getOwnedSegment();
            if (current === undefined) return;

            const nextText = sanitizeText(text);
            if (current.text === nextText) return;

            if (nextText === undefined) {
                delete current.text;
            } else {
                current.text = nextText;
            }

            emitStatusBarUpdates(state);
        },
        clear(): void {
            const current = getOwnedSegment();
            if (current === undefined) return;
            if (current.text === undefined) return;

            delete current.text;
            emitStatusBarUpdates(state);
        },
        dispose(): void {
            const current = getOwnedSegment();
            disposed = true;

            if (current === undefined) return;

            state.segments.delete(id);
            emitStatusBarUpdates(state);
        },
    };
}

/** Subscribe to status-bar changes. Intended for pi-status-bar internals. */
export function subscribeStatusBarUpdates(listener: () => void): () => void {
    const state = getStatusBarState();
    state.listeners.add(listener);

    return () => {
        state.listeners.delete(listener);
    };
}

/** Return the current status-bar snapshot. Intended for pi-status-bar internals and tests. */
export function getStatusBarSnapshot(): StatusBarSnapshot {
    const state = getStatusBarState();
    const base = state.base;
    const override = state.override;
    const segments: StatusBarSegmentSnapshot[] = [];

    for (const segment of state.segments.values()) {
        if (segment.text === undefined) continue;
        segments.push({
            id: segment.id,
            states: segment.states,
            side: segment.side,
            text: segment.text,
            priority: segment.priority,
            dimmed: segment.dimmed,
            italic: segment.italic,
        });
    }

    segments.sort((left, right) => {
        if (left.priority !== right.priority) return left.priority - right.priority;
        return left.id.localeCompare(right.id);
    });

    return {
        active: {
            text: override?.activeText ?? base.activeText,
            spinnerFrames: override?.spinnerFrames ?? base.spinnerFrames,
            timerVisible: override?.timerVisible ?? base.timerVisible ?? true,
            timerPaused: override?.timerPaused ?? base.timerPaused ?? false,
            timerResetVersion: state.timerResetVersion,
        },
        idle: {
            text: override?.idleText ?? base.idleText,
            visible: override?.idleVisible ?? base.idleVisible ?? true,
            showLastRunSummary:
                override?.idleShowLastRunSummary ?? base.idleShowLastRunSummary ?? true,
            showTokensPerSecond:
                override?.idleShowTokensPerSecond ?? base.idleShowTokensPerSecond ?? true,
        },
        segments,
    };
}

/** Clear global status-bar state. Intended for tests. */
export function resetStatusBarStateForTests(): void {
    delete statusBarGlobal[STATUS_BAR_STATE];
}
