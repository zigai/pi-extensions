import {
    FOOTER_CUSTOM_SLOT_ID_PATTERN,
    type FooterCustomSlotId,
    type FooterSide,
    type FooterSlotSnapshot,
    type SegmentColors,
} from "./footer-model.ts";

const CUSTOM_SLOT_COLORS = {
    bg: "",
    fg: "",
} as const;

const FOOTER_SLOT_STATE = Symbol.for("zigai.pi-footer.slot-state.v1");
const CUSTOM_SLOT_ID_REGEX = new RegExp(FOOTER_CUSTOM_SLOT_ID_PATTERN);
const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

/** Registration details for a custom pi-footer slot. */
export type FooterSlotRegistration = {
    /** Namespaced custom slot id, for example `my-extension.status`. */
    readonly id: string;

    /** Side used when the user has not placed or hidden this slot in config. */
    readonly defaultSide?: FooterSide;

    /** Initial visible text. Empty or whitespace-only text hides the slot. */
    readonly text?: string;

    /** Optional colors preserved for compatibility with block footer variants. */
    readonly colors?: SegmentColors;
};

/** Mutable handle returned by `registerFooterSlot`. */
export type FooterSlotHandle = {
    /** Replace this slot's visible text. Empty or whitespace-only text hides the slot. */
    setText(text: string): void;

    /** Hide this slot while keeping its registration and default placement. */
    clear(): void;

    /** Remove this slot registration. Stale handles become inert after disposal. */
    dispose(): void;
};

type MutableFooterSlot = {
    readonly id: FooterCustomSlotId;
    readonly owner: symbol;
    colors: SegmentColors;
    defaultSide?: FooterSide;
    text?: string;
};

type FooterSlotState = {
    readonly slots: Map<FooterCustomSlotId, MutableFooterSlot>;
    readonly listeners: Set<() => void>;
};

type FooterSlotGlobal = typeof globalThis & {
    [FOOTER_SLOT_STATE]?: FooterSlotState;
};

function getFooterSlotState(): FooterSlotState {
    // SAFETY: globalThis is the ambient global; FooterSlotGlobal only adds an optional namespaced slot state key.
    const globalState = globalThis as FooterSlotGlobal;
    let state = globalState[FOOTER_SLOT_STATE];
    if (state === undefined) {
        state = {
            slots: new Map(),
            listeners: new Set(),
        };
        globalState[FOOTER_SLOT_STATE] = state;
    }

    return state;
}

function parseFooterCustomSlotId(value: string): FooterCustomSlotId {
    if (!CUSTOM_SLOT_ID_REGEX.test(value)) {
        throw new Error(
            `[pi-footer] Custom footer slot id "${value}" must be namespaced, for example "my-extension.status".`,
        );
    }

    const separator = value.indexOf(".");
    return `${value.slice(0, separator)}.${value.slice(separator + 1)}`;
}

function parseFooterSide(value: string | undefined): FooterSide | undefined {
    if (value === undefined) return undefined;
    if (value === "left" || value === "right") return value;
    throw new Error(`[pi-footer] Custom footer slot defaultSide must be "left" or "right".`);
}

function parseHexColor(value: string, label: string): string {
    if (HEX_COLOR_REGEX.test(value)) return value;
    throw new Error(`[pi-footer] Custom footer slot ${label} must be a #RRGGBB hex color.`);
}

function parseSegmentColors(colors: SegmentColors | undefined): SegmentColors {
    if (colors === undefined) {
        return { ...CUSTOM_SLOT_COLORS };
    }

    return {
        bg: parseHexColor(colors.bg, "colors.bg"),
        fg: parseHexColor(colors.fg, "colors.fg"),
    };
}

function sanitizeSlotText(text: string): string {
    return text
        .replace(/[\r\n\t]/g, " ")
        .replace(/ +/g, " ")
        .trim();
}

function getVisibleSlotText(text: string | undefined): string | undefined {
    if (text === undefined) return undefined;

    const sanitized = sanitizeSlotText(text);
    if (sanitized.length === 0) return undefined;
    return sanitized;
}

function emitFooterSlotUpdates(state: FooterSlotState): void {
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
        throw new AggregateError(causes, "Footer slot update listeners failed.");
    }
}

/** Register or replace a custom footer slot for other extensions to update. */
export function registerFooterSlot(registration: FooterSlotRegistration): FooterSlotHandle {
    const state = getFooterSlotState();
    const id = parseFooterCustomSlotId(registration.id);
    const owner = Symbol(id);
    const slot: MutableFooterSlot = {
        id,
        owner,
        colors: parseSegmentColors(registration.colors),
    };

    const defaultSide = parseFooterSide(registration.defaultSide);
    if (defaultSide !== undefined) {
        slot.defaultSide = defaultSide;
    }

    const text = getVisibleSlotText(registration.text);
    if (text !== undefined) {
        slot.text = text;
    }

    state.slots.delete(id);
    state.slots.set(id, slot);
    emitFooterSlotUpdates(state);

    let disposed = false;

    function getOwnedSlot(): MutableFooterSlot | undefined {
        if (disposed) return undefined;

        const current = state.slots.get(id);
        if (current?.owner !== owner) {
            disposed = true;
            return undefined;
        }

        return current;
    }

    return {
        setText(nextText: string): void {
            const current = getOwnedSlot();
            if (current === undefined) return;

            const nextVisibleText = getVisibleSlotText(nextText);
            if (current.text === nextVisibleText) return;

            if (nextVisibleText === undefined) {
                delete current.text;
            } else {
                current.text = nextVisibleText;
            }

            emitFooterSlotUpdates(state);
        },
        clear(): void {
            const current = getOwnedSlot();
            if (current === undefined) return;
            if (current.text === undefined) return;

            delete current.text;
            emitFooterSlotUpdates(state);
        },
        dispose(): void {
            const current = getOwnedSlot();
            disposed = true;

            if (current === undefined) return;

            state.slots.delete(id);
            emitFooterSlotUpdates(state);
        },
    };
}

/** Subscribe to custom footer slot changes. Intended for pi-footer internals. */
export function subscribeFooterSlotUpdates(listener: () => void): () => void {
    const state = getFooterSlotState();
    state.listeners.add(listener);

    return () => {
        state.listeners.delete(listener);
    };
}

/** Return visible custom footer slots. Intended for pi-footer internals. */
export function getFooterSlotSnapshots(): FooterSlotSnapshot[] {
    const snapshots: FooterSlotSnapshot[] = [];
    for (const slot of getFooterSlotState().slots.values()) {
        if (slot.text === undefined) continue;

        const snapshot: FooterSlotSnapshot = {
            id: slot.id,
            text: slot.text,
            colors: { ...slot.colors },
        };
        if (slot.defaultSide !== undefined) {
            snapshots.push({ ...snapshot, defaultSide: slot.defaultSide });
        } else {
            snapshots.push(snapshot);
        }
    }

    return snapshots;
}
