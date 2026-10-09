import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import {
    installLinkedMethodPatch,
    type LinkedMethodPatchHandle,
} from "@zigai/pi-extension-internals";

const MODEL_STATUS_PATCH = Symbol.for("zigai.pi-ui-tweaks.model-status-patch");

export type ModelStatusConfig = { readonly hideModelChangeStatus: boolean };
export type ModelStatusHandle = { update(config: ModelStatusConfig): void; dispose(): void };
type ShowStatus = (this: InteractiveModeStatusTarget, message: string) => void;

type InteractiveModeStatusTarget = {
    showStatus: ShowStatus;
    ui: { requestRender(force?: boolean): void };
    [MODEL_STATUS_PATCH]?: ModelStatusPatchRecord;
};

type ModelStatusPatchRecord = {
    readonly original: ShowStatus;
    readonly patch: LinkedMethodPatchHandle<InteractiveModeStatusTarget, [string], void>;
    readonly handle: ModelStatusHandle;
};

type ShowStatusView = {
    [MODEL_STATUS_PATCH]?: ModelStatusPatchRecord;
    readonly showStatus?: ShowStatus;
};

function isShowStatusView(
    value: unknown,
): value is ShowStatusView & { readonly showStatus: ShowStatus } {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;

    // SAFETY: ShowStatusView exposes only the method validated by this predicate.
    const view = value as ShowStatusView;
    return typeof view.showStatus === "function";
}

function warnModelStatusPatchUnavailable(reason?: string): void {
    let suffix = "";
    if (reason !== undefined) suffix = `: ${reason}`;

    console.warn(
        `[pi-ui-tweaks] model status patch unavailable; Pi internals may have changed${suffix}`,
    );
}

function isModelChangeStatus(message: string): boolean {
    return /^Model: \S/.test(message);
}

function inactiveModelStatusHandle(): ModelStatusHandle {
    return { update(): void {}, dispose(): void {} };
}

/** Installs or updates the model-change status patch. */
export function installModelStatusPatch(
    config: ModelStatusConfig,
    target?: ShowStatusView | null,
): ModelStatusHandle {
    let candidate = target;
    if (candidate === undefined && isShowStatusView(InteractiveMode.prototype)) {
        candidate = InteractiveMode.prototype;
    }

    if (!isShowStatusView(candidate)) {
        warnModelStatusPatchUnavailable("missing showStatus");
        return inactiveModelStatusHandle();
    }

    const prototype = candidate;
    const installed = prototype[MODEL_STATUS_PATCH];
    if (installed !== undefined) {
        installed.handle.update(config);
        return installed.handle;
    }

    let current = config;
    const patch = installLinkedMethodPatch(
        prototype,
        "showStatus",
        (predecessor) =>
            function patchedShowStatus(this: InteractiveModeStatusTarget, message: string): void {
                if (current.hideModelChangeStatus && isModelChangeStatus(message)) {
                    this.ui.requestRender();
                    return;
                }

                predecessor.call(this, message);
            },
    );
    let disposed = false;
    const handle: ModelStatusHandle = {
        update(next): void {
            if (!disposed) current = next;
        },
        dispose(): void {
            if (disposed) return;

            disposed = true;
            patch.dispose();

            if (prototype[MODEL_STATUS_PATCH]?.handle === handle)
                delete prototype[MODEL_STATUS_PATCH];
        },
    };

    prototype[MODEL_STATUS_PATCH] = { original: patch.predecessor, patch, handle };
    return handle;
}
