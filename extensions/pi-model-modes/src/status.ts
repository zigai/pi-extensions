import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import {
    installLinkedMethodPatch,
    warnPiInternalPatchUnavailable,
    type LinkedMethodPatchHandle,
} from "@zigai/pi-extension-internals";

const STATUS_PATCH_MARKER = Symbol.for("zigai.pi-model-modes.thinking-status-patch");
const THINKING_LEVEL_STATUS_PREFIX = "Thinking level: ";
const PATCH_SCOPE = "pi-model-modes";
const PATCH_FEATURE = "thinking-level status patch";

type InteractiveModePrototype = {
    showStatus(message: string): void;
    [STATUS_PATCH_MARKER]?: unknown;
};

type InteractiveModeModule = {
    readonly InteractiveMode: {
        readonly prototype: InteractiveModePrototype;
    };
};

type ShowStatus = (this: InteractiveModePrototype, message: string) => void;

type StatusPatchState = {
    readonly predicate: { current: () => boolean };
    readonly handle: LinkedMethodPatchHandle<InteractiveModePrototype, [message: string], void>;
};

export type ThinkingLevelStatusPatchOptions = {
    readonly loadInteractiveModeModule?: () => Promise<InteractiveModeModule>;
    readonly shouldShowThinkingLevelStatus?: () => boolean;
};

function isStatusPatchState(value: unknown): value is StatusPatchState {
    if (
        typeof value !== "object" ||
        value === null ||
        !("predicate" in value) ||
        !("handle" in value)
    ) {
        return false;
    }

    const { predicate, handle } = value;

    return (
        typeof predicate === "object" &&
        predicate !== null &&
        "current" in predicate &&
        typeof predicate.current === "function" &&
        typeof handle === "object" &&
        handle !== null &&
        "predecessor" in handle &&
        typeof handle.predecessor === "function" &&
        "patched" in handle &&
        typeof handle.patched === "function" &&
        "dispose" in handle &&
        typeof handle.dispose === "function"
    );
}

function isInteractiveModeModule(value: unknown): value is InteractiveModeModule {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
        return false;
    }

    if (!("InteractiveMode" in value)) return false;

    const { InteractiveMode } = value;
    if (
        (typeof InteractiveMode !== "object" || InteractiveMode === null) &&
        typeof InteractiveMode !== "function"
    ) {
        return false;
    }

    if (!("prototype" in InteractiveMode)) return false;

    const { prototype } = InteractiveMode;
    return (
        ((typeof prototype === "object" && prototype !== null) ||
            typeof prototype === "function") &&
        "showStatus" in prototype &&
        typeof prototype.showStatus === "function"
    );
}

export function restoreThinkingLevelStatusPatch(prototype?: InteractiveModePrototype): void {
    if (prototype === undefined) return;

    const state: unknown = prototype[STATUS_PATCH_MARKER];
    if (!isStatusPatchState(state)) {
        delete prototype[STATUS_PATCH_MARKER];
        return;
    }

    state.handle.dispose();
    delete prototype[STATUS_PATCH_MARKER];
}

export async function applyThinkingLevelStatusPatch(
    options: ThinkingLevelStatusPatchOptions = {},
): Promise<() => void> {
    let prototype: InteractiveModePrototype | undefined;
    if (options.loadInteractiveModeModule === undefined) {
        const module = { InteractiveMode };
        if (isInteractiveModeModule(module)) {
            prototype = module.InteractiveMode.prototype;
        } else {
            warnPiInternalPatchUnavailable(PATCH_SCOPE, PATCH_FEATURE);
        }
    } else {
        const loadedModule = await options.loadInteractiveModeModule();
        if (isInteractiveModeModule(loadedModule)) {
            prototype = loadedModule.InteractiveMode.prototype;
        }
    }

    if (prototype === undefined) {
        if (options.loadInteractiveModeModule !== undefined) {
            warnPiInternalPatchUnavailable(PATCH_SCOPE, PATCH_FEATURE);
        }

        return () => {};
    }

    const existing: unknown = prototype[STATUS_PATCH_MARKER];
    if (isStatusPatchState(existing)) {
        existing.predicate.current =
            options.shouldShowThinkingLevelStatus ?? existing.predicate.current;

        return () => restoreThinkingLevelStatusPatch(prototype);
    }

    if (existing !== undefined) {
        delete prototype[STATUS_PATCH_MARKER];
    }

    const predicate = {
        current: options.shouldShowThinkingLevelStatus ?? (() => true),
    };
    const handle = installLinkedMethodPatch(
        prototype,
        "showStatus",
        (predecessor): ShowStatus =>
            function patchedShowStatus(message: string): void {
                if (message.startsWith(THINKING_LEVEL_STATUS_PREFIX) && !predicate.current()) {
                    return;
                }

                predecessor.call(this, message);
            },
    );

    prototype[STATUS_PATCH_MARKER] = { predicate, handle };

    return () => restoreThinkingLevelStatusPatch(prototype);
}
