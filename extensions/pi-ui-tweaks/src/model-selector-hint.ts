import { ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import {
    installLinkedMethodPatch,
    type LinkedMethodPatchHandle,
} from "@zigai/pi-extension-internals";

const MODEL_PROVIDER_HINT_TEXT =
    "Only showing models from configured providers. Use /login to add providers.";
const MODEL_SELECTOR_HINT_PATCH = Symbol.for("zigai.pi-ui-tweaks.model-selector-hint-patch");
const selectorInstancesSkippingNextSpacer = new WeakSet();

export type ModelSelectorHintConfig = {
    readonly compactModelSelector: boolean;
    readonly hideModelProviderHint: boolean;
};

export type ModelSelectorHintHandle = {
    update(config: ModelSelectorHintConfig): void;
    dispose(): void;
};

type ComponentLike = { render(width: number): string[]; invalidate(): void };
type AddChild = (this: ModelSelectorAddChildTarget, component: ComponentLike) => void;

type ModelSelectorAddChildTarget = {
    addChild: AddChild;
    [MODEL_SELECTOR_HINT_PATCH]?: ModelSelectorHintPatchRecord;
};

type ModelSelectorHintPatchRecord = {
    readonly original: AddChild;
    readonly patch: LinkedMethodPatchHandle<ModelSelectorAddChildTarget, [ComponentLike], void>;
    readonly handle: ModelSelectorHintHandle;
};

type AddChildView = Partial<ModelSelectorAddChildTarget>;

function hasAddChild(target: AddChildView): target is ModelSelectorAddChildTarget {
    return typeof target.addChild === "function";
}

function warnModelSelectorHintPatchUnavailable(reason?: string): void {
    let suffix = "";
    if (reason !== undefined) suffix = `: ${reason}`;

    console.warn(
        `[pi-ui-tweaks] model picker hint patch unavailable; Pi internals may have changed${suffix}`,
    );
}

function isObject(value: unknown): value is object {
    return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isSingleLineSpacer(component: ComponentLike): boolean {
    if (!("lines" in component) || component.lines !== 1) return false;

    const constructorValue = component.constructor;
    if (!isObject(constructorValue)) return false;
    return "name" in constructorValue && constructorValue.name === "Spacer";
}

function isModelProviderHintText(
    component: ComponentLike,
): component is ComponentLike & { readonly text: string } {
    return (
        "text" in component &&
        typeof component.text === "string" &&
        component.text.includes(MODEL_PROVIDER_HINT_TEXT)
    );
}

/** Installs or updates the model-selector hint patch. */
export function installModelSelectorHintPatch(
    config: ModelSelectorHintConfig,
    target: AddChildView | null = ModelSelectorComponent.prototype,
): ModelSelectorHintHandle {
    if (target === null) {
        warnModelSelectorHintPatchUnavailable();

        return { update(): void {}, dispose(): void {} };
    }

    if (!hasAddChild(target)) {
        warnModelSelectorHintPatchUnavailable("missing addChild");

        return { update(): void {}, dispose(): void {} };
    }

    const prototype = target;
    const installed = prototype[MODEL_SELECTOR_HINT_PATCH];
    if (installed !== undefined) {
        installed.handle.update(config);
        return installed.handle;
    }

    let current = config;
    const patch = installLinkedMethodPatch(
        prototype,
        "addChild",
        (predecessor) =>
            function patchedModelSelectorAddChild(
                this: ModelSelectorAddChildTarget,
                component: ComponentLike,
            ): void {
                if (selectorInstancesSkippingNextSpacer.has(this)) {
                    selectorInstancesSkippingNextSpacer.delete(this);

                    if (isSingleLineSpacer(component)) return;
                }

                if (current.compactModelSelector && isSingleLineSpacer(component)) return;

                if (current.hideModelProviderHint && isModelProviderHintText(component)) {
                    selectorInstancesSkippingNextSpacer.add(this);
                    return;
                }

                predecessor.call(this, component);
            },
    );
    let disposed = false;
    const handle: ModelSelectorHintHandle = {
        update(next): void {
            if (!disposed) current = next;
        },
        dispose(): void {
            if (disposed) return;

            disposed = true;
            patch.dispose();

            if (prototype[MODEL_SELECTOR_HINT_PATCH]?.handle === handle) {
                delete prototype[MODEL_SELECTOR_HINT_PATCH];
            }
        },
    };

    prototype[MODEL_SELECTOR_HINT_PATCH] = { original: patch.predecessor, patch, handle };
    return handle;
}
