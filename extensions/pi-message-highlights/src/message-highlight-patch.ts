import { AssistantMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, Editor, Markdown, MouseRegion, Text } from "@earendil-works/pi-tui";
import {
    installLinkedRenderPatch,
    type LinkedMethodPatchHandle,
} from "@zigai/pi-extension-internals";

import { highlightEditorRenderLines, type EditorHighlightTarget } from "./editor-highlighting.ts";
import {
    highlightMessageLines,
    highlightWebLinkLabelLines,
    highlightFallbackMarkdownLinkLabels,
    type HighlightStyles,
} from "./highlight-text.ts";
import { buildHighlightStyles, type HighlightTheme } from "./highlight-styles.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
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

export async function loadMessageHighlightTargets(): Promise<MessageHighlightTargets | undefined> {
    // Static imports use Pi's extension-loader aliases, so these are the live UI classes.
    return {
        assistantPrototype: AssistantMessageComponent.prototype,
        userPrototype: UserMessageComponent.prototype,
        editorPrototype: Editor.prototype,
    };
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

function patchAssistantPrototype(
    prototype: RenderablePrototype,
    getStyles: HighlightStylesProvider,
    thinking: { active: number },
): RenderPatchHandle {
    return installLinkedRenderPatch(
        prototype,
        (predecessor) =>
            function highlightedAssistantRender(this: RenderableInstance, width: number): string[] {
                // Pi's clickable thinking runs are MouseRegions inside the content container.
                // Decorate at that boundary rather than recoloring the flattened transcript.
                if (
                    !("contentContainer" in this) ||
                    !(this.contentContainer instanceof Container)
                ) {
                    thinking.active += 1;
                    try {
                        return predecessor.call(this, width);
                    } finally {
                        thinking.active -= 1;
                    }
                }

                const patches: RenderPatchHandle[] = [];

                try {
                    for (const child of this.contentContainer.children) {
                        let styles = getStyles();
                        if (child instanceof MouseRegion) {
                            styles = { url: "\u001b[1m", filepath: "\u001b[1m" };
                            const thinkingStyles = styles;
                            const renderable: RenderablePrototype = child;
                            patches.push(
                                installLinkedRenderPatch(
                                    renderable,
                                    (render) =>
                                        function (
                                            this: RenderableInstance,
                                            width: number,
                                        ): string[] {
                                            thinking.active += 1;
                                            try {
                                                return highlightMessageLines(
                                                    render.call(this, width),
                                                    thinkingStyles,
                                                );
                                            } finally {
                                                thinking.active -= 1;
                                            }
                                        },
                                ),
                            );
                        } else {
                            patches.push(patchRenderablePrototype(child, () => styles));
                        }
                    }

                    return predecessor.call(this, width);
                } finally {
                    for (const patch of patches) patch.dispose();
                }
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
    const thinking = { active: 0 };

    try {
        const webPrototypes: RenderablePrototype[] = [Text.prototype, Markdown.prototype];
        for (const prototype of webPrototypes) {
            patches.push(
                installLinkedRenderPatch(
                    prototype,
                    (predecessor) =>
                        function (this: RenderableInstance, width: number): string[] {
                            const lines = predecessor.call(this, width);
                            if (thinking.active > 0) return lines;
                            const styles = getStyles();
                            const urlOnly = { url: styles.url, filepath: "" };
                            let result = highlightWebLinkLabelLines(
                                highlightMessageLines(lines, urlOnly),
                                styles.url,
                            );
                            if (this instanceof Markdown) {
                                const descriptor = Object.getOwnPropertyDescriptor(this, "text");
                                if (
                                    descriptor !== undefined &&
                                    Object.hasOwn(descriptor, "value")
                                ) {
                                    const source: unknown = descriptor.value;
                                    if (Value.Check(Type.String(), source))
                                        result = highlightFallbackMarkdownLinkLabels(
                                            result,
                                            source,
                                            styles.url,
                                        );
                                }
                            }
                            return result;
                        },
                ),
            );
        }
        patches.push(patchAssistantPrototype(targets.assistantPrototype, getStyles, thinking));
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
