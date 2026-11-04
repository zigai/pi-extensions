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

type CachedHighlight = {
    lines: string[];
    styles: HighlightStyles;
    source: string | undefined;
    result: string[];
};

class HighlightRenderCache {
    private entries = new WeakMap<RenderableInstance, CachedHighlight>();
    private frames = new WeakMap<RenderableInstance, Set<RenderableInstance>>();
    private activeFrame: Set<RenderableInstance> | undefined;

    renderFrame(target: RenderableInstance, render: () => string[]): string[] {
        const previousActive = this.activeFrame;
        const frame = new Set<RenderableInstance>();
        this.activeFrame = frame;
        try {
            return render();
        } finally {
            this.activeFrame = previousActive;
            const previous = this.frames.get(target);
            if (previous !== undefined) {
                for (const child of previous) {
                    if (!frame.has(child)) this.entries.delete(child);
                }
            }
            this.frames.set(target, frame);
        }
    }

    render(
        target: RenderableInstance,
        lines: readonly string[],
        styles: HighlightStyles,
        transform: () => string[],
        source?: string,
    ): string[] {
        this.activeFrame?.add(target);
        const cached = this.entries.get(target);
        if (
            cached !== undefined &&
            cached.styles.url === styles.url &&
            cached.styles.filepath === styles.filepath &&
            cached.source === source &&
            cached.lines.length === lines.length &&
            cached.lines.every((line, index) => line === lines[index])
        ) {
            return [...cached.result];
        }

        const result = transform();
        this.entries.set(target, {
            lines: [...lines],
            styles: { ...styles },
            source,
            result: [...result],
        });
        return result;
    }

    clear(): void {
        this.entries = new WeakMap();
        this.frames = new WeakMap();
        this.activeFrame = undefined;
    }
}

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
    cache: HighlightRenderCache,
): RenderPatchHandle {
    return installLinkedRenderPatch(
        prototype,
        (predecessor) =>
            function highlightedRender(this: RenderableInstance, width: number): string[] {
                const lines = predecessor.call(this, width);
                const styles = getStyles();
                return cache.render(this, lines, styles, () =>
                    highlightMessageLines(lines, styles),
                );
            },
    );
}

function patchAssistantPrototype(
    prototype: RenderablePrototype,
    getStyles: HighlightStylesProvider,
    thinking: { active: number },
    cache: HighlightRenderCache,
    webCache: HighlightRenderCache,
): RenderPatchHandle {
    return installLinkedRenderPatch(
        prototype,
        (predecessor) =>
            function highlightedAssistantRender(this: RenderableInstance, width: number): string[] {
                return cache.renderFrame(this, () =>
                    webCache.renderFrame(this, () => {
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
                                                        const lines = render.call(this, width);
                                                        return cache.render(
                                                            this,
                                                            lines,
                                                            thinkingStyles,
                                                            () =>
                                                                highlightMessageLines(
                                                                    lines,
                                                                    thinkingStyles,
                                                                ),
                                                        );
                                                    } finally {
                                                        thinking.active -= 1;
                                                    }
                                                },
                                        ),
                                    );
                                } else {
                                    patches.push(
                                        patchRenderablePrototype(child, () => styles, cache),
                                    );
                                }
                            }

                            return predecessor.call(this, width);
                        } finally {
                            for (const patch of patches) patch.dispose();
                        }
                    }),
                );
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
    const messageCache = new HighlightRenderCache();
    const webCache = new HighlightRenderCache();

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
                            let source: string | undefined;
                            if (this instanceof Markdown) {
                                const descriptor = Object.getOwnPropertyDescriptor(this, "text");
                                if (
                                    descriptor !== undefined &&
                                    Object.hasOwn(descriptor, "value")
                                ) {
                                    const value: unknown = descriptor.value;
                                    if (Value.Check(Type.String(), value)) source = value;
                                }
                            }
                            return webCache.render(
                                this,
                                lines,
                                urlOnly,
                                () => {
                                    let result = highlightWebLinkLabelLines(
                                        highlightMessageLines(lines, urlOnly),
                                        styles.url,
                                    );
                                    if (source !== undefined) {
                                        result = highlightFallbackMarkdownLinkLabels(
                                            result,
                                            source,
                                            styles.url,
                                        );
                                    }
                                    return result;
                                },
                                source,
                            );
                        },
                ),
            );
        }
        patches.push(
            patchAssistantPrototype(
                targets.assistantPrototype,
                getStyles,
                thinking,
                messageCache,
                webCache,
            ),
        );
        patches.push(patchRenderablePrototype(targets.userPrototype, getStyles, messageCache));

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
            messageCache.clear();
            webCache.clear();

            if (state[MESSAGE_HIGHLIGHTS_PATCH_KEY]?.handle === handle) {
                delete state[MESSAGE_HIGHLIGHTS_PATCH_KEY];
            }

            disposed = true;
        },
    };

    state[MESSAGE_HIGHLIGHTS_PATCH_KEY] = { handle };
    return handle;
}
