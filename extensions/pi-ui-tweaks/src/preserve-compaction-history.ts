import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import {
    reportExtensionDiagnostic,
    installLinkedMethodPatch,
    type LinkedMethodPatchHandle,
} from "@zigai/pi-extension-internals";

const PRESERVE_COMPACTION_HISTORY_PATCH = Symbol.for(
    "zigai.pi-ui-tweaks.preserve-compaction-history-patch",
);

export type PreserveCompactionHistoryConfig = { readonly preserveCompactionHistory: boolean };

export type PreserveCompactionHistoryHandle = {
    update(config: PreserveCompactionHistoryConfig): void;
    dispose(): void;
};

type CompactionEventView = {
    readonly type?: unknown;
    readonly aborted?: unknown;
    readonly result?: unknown;
};

type SuccessfulCompactionEvent = CompactionEventView & {
    readonly type: "compaction_end";
    readonly aborted: false;
    readonly result: unknown;
};

type ChatContainer = { clear: () => void };

type HandleEvent = (
    this: InteractiveModeCompactionTarget,
    event: CompactionEventView,
) => Promise<void>;

type InteractiveModeCompactionTarget = {
    chatContainer: ChatContainer;
    handleEvent: HandleEvent;
    rebuildChatFromMessages: () => void;
    renderSessionEntries: () => void;
    [PRESERVE_COMPACTION_HISTORY_PATCH]?: PreserveCompactionHistoryRecord;
};

type PreserveCompactionHistoryRecord = {
    readonly original: HandleEvent;

    readonly patch: LinkedMethodPatchHandle<
        InteractiveModeCompactionTarget,
        [CompactionEventView],
        Promise<void>
    >;

    readonly handle: PreserveCompactionHistoryHandle;
};

type ChatContainerView = {
    readonly chatContainer?: unknown;
    readonly rebuildChatFromMessages?: unknown;
    readonly renderSessionEntries?: unknown;
};

type ClearView = {
    readonly clear?: unknown;
};

type HandleEventView = {
    [PRESERVE_COMPACTION_HISTORY_PATCH]?: PreserveCompactionHistoryRecord;
    readonly handleEvent?: unknown;
};

function isObject(value: unknown): value is object {
    return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isHandleEventView(
    value: unknown,
): value is HandleEventView & { readonly handleEvent: HandleEvent } {
    if (!isObject(value)) return false;

    // SAFETY: HandleEventView exposes only the method validated by this predicate.
    const view = value as HandleEventView;
    return typeof view.handleEvent === "function";
}

function isSuccessfulCompaction(event: CompactionEventView): event is SuccessfulCompactionEvent {
    return event.type === "compaction_end" && event.aborted === false && event.result !== undefined;
}

function isInteractiveModeCompactionTarget(
    value: unknown,
): value is InteractiveModeCompactionTarget {
    if (!isObject(value)) return false;

    // SAFETY: ChatContainerView exposes only the two private members validated below.
    const view = value as ChatContainerView;
    const chatContainer: unknown = view.chatContainer;
    if (!isObject(chatContainer)) return false;

    // SAFETY: ClearView exposes only the clear method validated below.
    const clearView = chatContainer as ClearView;
    return (
        typeof clearView.clear === "function" &&
        typeof view.rebuildChatFromMessages === "function" &&
        typeof view.renderSessionEntries === "function"
    );
}

function warnPreserveCompactionHistoryPatchUnavailable(reason?: string): void {
    let suffix = "";
    if (reason !== undefined) suffix = `: ${reason}`;

    reportExtensionDiagnostic(
        `[pi-ui-tweaks] preserve compaction history patch unavailable; Pi internals may have changed${suffix}`,
    );
}

/** Installs or updates the live-compaction transcript-preservation patch. */
export function installPreserveCompactionHistoryPatch(
    config: PreserveCompactionHistoryConfig,
    target?: HandleEventView | null,
): PreserveCompactionHistoryHandle {
    let candidate = target;
    if (candidate === undefined && isHandleEventView(InteractiveMode.prototype)) {
        candidate = InteractiveMode.prototype;
    }

    if (!isHandleEventView(candidate)) {
        warnPreserveCompactionHistoryPatchUnavailable("missing handleEvent");

        return { update(): void {}, dispose(): void {} };
    }

    const prototype = candidate;
    const installed = prototype[PRESERVE_COMPACTION_HISTORY_PATCH];
    if (installed !== undefined) {
        installed.handle.update(config);
        return installed.handle;
    }

    let current = config;
    const patch = installLinkedMethodPatch(
        prototype,
        "handleEvent",
        (predecessor) =>
            async function patchedHandleEvent(
                this: InteractiveModeCompactionTarget,
                event: CompactionEventView,
            ): Promise<void> {
                if (
                    !current.preserveCompactionHistory ||
                    !isSuccessfulCompaction(event) ||
                    !isInteractiveModeCompactionTarget(this)
                )
                    return predecessor.call(this, event);

                // Pi replays the retained window directly after clearing. Preserve the existing
                // rows instead of appending duplicates, while still allowing the new summary.
                const originalMethods = {
                    clear: this.chatContainer.clear,
                    rebuild: this.rebuildChatFromMessages,
                    renderEntries: this.renderSessionEntries,
                };

                this.chatContainer.clear = () => {};
                this.rebuildChatFromMessages = () => {};
                this.renderSessionEntries = () => {};

                try {
                    await predecessor.call(this, event);
                } finally {
                    this.chatContainer.clear = originalMethods.clear;
                    this.rebuildChatFromMessages = originalMethods.rebuild;
                    this.renderSessionEntries = originalMethods.renderEntries;
                }
            },
    );
    let disposed = false;
    const handle: PreserveCompactionHistoryHandle = {
        update(next): void {
            if (!disposed) current = next;
        },
        dispose(): void {
            if (disposed) return;

            disposed = true;
            patch.dispose();

            if (prototype[PRESERVE_COMPACTION_HISTORY_PATCH]?.handle === handle) {
                delete prototype[PRESERVE_COMPACTION_HISTORY_PATCH];
            }
        },
    };

    prototype[PRESERVE_COMPACTION_HISTORY_PATCH] = { original: patch.predecessor, patch, handle };
    return handle;
}
