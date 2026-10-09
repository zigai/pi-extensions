import { Editor } from "@earendil-works/pi-tui";
import {
    installLinkedRenderPatch,
    type LinkedMethodPatchHandle,
} from "@zigai/pi-extension-internals";

import { highlightEditorRenderLines, type EditorHighlightTarget } from "./editor-highlighting.ts";
import { highlightMessageLines, type HighlightStyles } from "./highlight-text.ts";
import { buildHighlightStyles, type HighlightTheme } from "./highlight-styles.ts";
import type { MessageHighlightsConfig } from "./settings.ts";

const MESSAGE_HIGHLIGHTS_PATCH_KEY = Symbol.for("zigai.pi-message-highlights.patched");

type HighlightStylesProvider = () => HighlightStyles;

type RenderableInstance = {
    render: (this: RenderableInstance, width: number) => string[];
};

type RenderablePrototype = { render: (this: RenderableInstance, width: number) => string[] };
type RenderPatchHandle = LinkedMethodPatchHandle<RenderableInstance, [width: number], string[]>;

export type MessageHighlightPatchHandle = {
    update(config: MessageHighlightsConfig): void;
    dispose(): void;
};

type MessageHighlightsPatchRecord = { handle: MessageHighlightPatchHandle };

type PatchState = typeof globalThis & {
    [MESSAGE_HIGHLIGHTS_PATCH_KEY]?: MessageHighlightsPatchRecord;
};

type EditorHighlightPrototype = RenderablePrototype & {
    getText?: (() => string) | undefined;
};

function isObjectIdentity(value: unknown): value is object {
    return (typeof value === "object" && value !== null) || typeof value === "function";
}

type UnknownModuleDescriptor = Omit<PropertyDescriptor, "value"> & {
    readonly value: unknown;
};

function isUnknownModuleDescriptor(
    descriptor: PropertyDescriptor | undefined,
): descriptor is UnknownModuleDescriptor {
    return descriptor !== undefined && Object.hasOwn(descriptor, "value");
}

/* oxlint-disable antislop/no-unknown-parameters -- This is the parser boundary for a private Pi module namespace. */
function parseMessageComponent(
    module: unknown,
    exportName: "AssistantMessageComponent" | "UserMessageComponent",
): RenderablePrototype | undefined {
    if (!isObjectIdentity(module)) return undefined;

    const descriptor = Object.getOwnPropertyDescriptor(module, exportName);
    if (!isUnknownModuleDescriptor(descriptor)) return undefined;

    const component = descriptor.value;
    if (
        !isObjectIdentity(component) ||
        !("prototype" in component) ||
        !isObjectIdentity(component.prototype) ||
        !("render" in component.prototype) ||
        typeof component.prototype.render !== "function"
    ) {
        return undefined;
    }
    // SAFETY: The only consumed method is callable; its private receiver signature is fixed
    // by the pinned Pi version and exercised by package integration tests.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Callable private render signature verified above.
    return component.prototype as RenderablePrototype;
}
/* oxlint-enable antislop/no-unknown-parameters */

function getEditorPrototype(): RenderablePrototype {
    return Editor.prototype;
}

export async function loadMessageHighlightTargets(): Promise<MessageHighlightTargets | undefined> {
    // Use Pi's public exports: private dist subpaths can be different classes from the live UI.
    const module: unknown = await import("@earendil-works/pi-coding-agent");
    const assistantPrototype = parseMessageComponent(module, "AssistantMessageComponent");
    const userPrototype = parseMessageComponent(module, "UserMessageComponent");
    if (assistantPrototype === undefined || userPrototype === undefined) return undefined;

    return { assistantPrototype, userPrototype, editorPrototype: getEditorPrototype() };
}

function isEditorHighlightTarget(
    value: EditorHighlightPrototype,
): value is EditorHighlightPrototype & EditorHighlightTarget {
    return typeof value.getText === "function";
}

function patchRenderablePrototype(
    prototype: RenderablePrototype,
    getStyles: HighlightStylesProvider,
): RenderPatchHandle {
    return installLinkedRenderPatch(
        prototype,
        (predecessor) =>
            function highlightedRender(this: RenderableInstance, width: number): string[] {
                return highlightMessageLines(predecessor.call(this, width), getStyles());
            },
    );
}

function patchEditorPrototype(
    prototype: RenderablePrototype,
    getStyles: HighlightStylesProvider,
): RenderPatchHandle | undefined {
    if (!isEditorHighlightTarget(prototype)) return undefined;
    return installLinkedRenderPatch(
        prototype,
        (predecessor) =>
            function highlightedEditorRender(this: RenderableInstance, width: number): string[] {
                const renderedLines = predecessor.call(this, width);
                if (isEditorHighlightTarget(this)) {
                    return highlightEditorRenderLines(this, width, renderedLines, getStyles());
                }

                return highlightMessageLines(renderedLines, getStyles());
            },
    );
}

export type MessageHighlightTargets = {
    assistantPrototype: RenderablePrototype;
    userPrototype: RenderablePrototype;
    editorPrototype: RenderablePrototype;
};

export function installMessageHighlightPatch(
    targets: MessageHighlightTargets,
    config: MessageHighlightsConfig,
    getTheme: () => HighlightTheme | undefined,
): MessageHighlightPatchHandle {
    const state: PatchState = globalThis;
    const existing = state[MESSAGE_HIGHLIGHTS_PATCH_KEY];
    if (existing !== undefined) {
        existing.handle.update(config);
        return existing.handle;
    }

    let currentConfig = config;
    let disposed = false;
    const getStyles = () => buildHighlightStyles(getTheme(), currentConfig);
    const patches: RenderPatchHandle[] = [];

    try {
        patches.push(patchRenderablePrototype(targets.assistantPrototype, getStyles));
        patches.push(patchRenderablePrototype(targets.userPrototype, getStyles));

        const editorPatch = patchEditorPrototype(targets.editorPrototype, getStyles);
        if (editorPatch !== undefined) patches.push(editorPatch);
    } catch (cause) {
        for (const patch of patches) patch.dispose();

        throw cause;
    }

    const handle: MessageHighlightPatchHandle = {
        update(next): void {
            if (!disposed) currentConfig = next;
        },
        dispose(): void {
            if (disposed) return;

            for (const patch of patches) patch.dispose();

            if (state[MESSAGE_HIGHLIGHTS_PATCH_KEY]?.handle === handle) {
                delete state[MESSAGE_HIGHLIGHTS_PATCH_KEY];
            }

            disposed = true;
        },
    };

    state[MESSAGE_HIGHLIGHTS_PATCH_KEY] = { handle };
    return handle;
}
