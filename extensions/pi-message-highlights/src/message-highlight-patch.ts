import { AssistantMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, Editor, Markdown, MouseRegion, Text } from "@earendil-works/pi-tui";
import {
    installLinkedMethodPatch,
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
    private frames = new WeakMap<RenderableInstance, Set<WeakRef<RenderableInstance>>>();
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
            let unchanged = previous?.size === frame.size;
            if (previous !== undefined) {
                for (const reference of previous) {
                    const child = reference.deref();
                    if (child === undefined || !frame.has(child)) {
                        unchanged = false;

                        if (child !== undefined) this.entries.delete(child);
                    }
                }
            }

            // Keep weak membership stable as well as the render patches. Rebuilding
            // these sets on every cached historical row allocates new WeakRefs despite
            // identical ownership; changed/dead members still replace the whole frame.
            if (!unchanged)
                this.frames.set(target, new Set([...frame].map((child) => new WeakRef(child))));
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

// Linked handles close over their targets. Keep them only in an ephemeron, not a
// session-long array: even an unrendered, removed child must be collectible. The
// weak registry permits deterministic disposal of live targets without retaining
// old transcripts. Finalization only prunes registry bookkeeping, never patches.
type DisposablePatch = { dispose(): void };

type OwnedRenderPatch = {
    target: WeakRef<RenderableInstance>;
    handle: DisposablePatch;
};

class WeakRenderPatches {
    private entries = new WeakMap<RenderableInstance, OwnedRenderPatch>();
    private readonly references = new Set<WeakRef<OwnedRenderPatch>>();

    private readonly finalizer = new FinalizationRegistry<WeakRef<OwnedRenderPatch>>(
        (reference) => {
            this.references.delete(reference);
        },
    );

    install(target: RenderableInstance, create: () => DisposablePatch): void {
        if (this.entries.has(target)) return;

        const entry = { target: new WeakRef(target), handle: create() };
        const reference = new WeakRef(entry);

        this.entries.set(target, entry);
        this.references.add(reference);
        this.finalizer.register(target, reference, entry);
    }

    remove(target: RenderableInstance): void {
        const entry = this.entries.get(target);
        if (entry === undefined) return;

        entry.handle.dispose();
        this.entries.delete(target);
        this.finalizer.unregister(entry);

        // Mutation-only path: ordinary redraws never scan this registry.
        for (const reference of this.references) {
            if (reference.deref() === entry) this.references.delete(reference);
        }
    }

    retain(targets: readonly RenderableInstance[]): void {
        const current = new Set(targets);

        this.visit((entry) => {
            const target = entry.target.deref();
            if (target !== undefined && current.has(target)) return false;

            entry.handle.dispose();

            if (target !== undefined) this.entries.delete(target);
            return true;
        });
    }

    dispose(): void {
        this.visit((entry) => {
            entry.handle.dispose();
            return true;
        });
        this.entries = new WeakMap();
    }

    private visit(remove: (entry: OwnedRenderPatch) => boolean): void {
        for (const reference of this.references) {
            const entry = reference.deref();
            if (entry === undefined) {
                this.references.delete(reference);
            } else if (remove(entry)) {
                this.finalizer.unregister(entry);
                this.references.delete(reference);
            }
        }
    }
}

// A child's container may be collected while another extension retains the
// child. Session disposal must still find that child's live handle. This second
// ephemeron registry is independent of container lifetime, and supports multiple
// container-owned handles for the same (shared) child without pinning either.
class WeakChildPatchDisposals {
    private handles = new WeakMap<RenderableInstance, Set<DisposablePatch>>();
    private readonly references = new Set<WeakRef<DisposablePatch>>();

    private readonly finalizer = new FinalizationRegistry<WeakRef<DisposablePatch>>((reference) => {
        this.references.delete(reference);
    });

    track(target: RenderableInstance, handle: DisposablePatch): DisposablePatch {
        const handles = this.handles.get(target) ?? new Set<DisposablePatch>();
        this.handles.set(target, handles);
        handles.add(handle);

        const reference = new WeakRef(handle);
        this.references.add(reference);
        this.finalizer.register(target, reference, handle);

        return {
            dispose: (): void => {
                handle.dispose();
                handles.delete(handle);
                this.references.delete(reference);
                this.finalizer.unregister(handle);
            },
        };
    }

    dispose(): void {
        for (const reference of this.references) {
            const handle = reference.deref();
            if (handle !== undefined) {
                handle.dispose();
                this.finalizer.unregister(handle);
            }
        }

        this.references.clear();
        this.handles = new WeakMap();
    }
}

type AssistantRenderGate = { depth: number; styles: HighlightStyles[] };

const THINKING_HIGHLIGHT_STYLES: HighlightStyles = { url: "\u001b[1m", filepath: "\u001b[1m" };

// Keep this factory outside the container installer. A retained child must not
// close over the installer's lexical context (container, siblings, or handles).
function patchAssistantChild(
    child: RenderableInstance,
    gate: AssistantRenderGate,
    thinking: { active: number },
    cache: HighlightRenderCache,
): RenderPatchHandle {
    const isThinking = child instanceof MouseRegion;
    let active = true;
    const patch = installLinkedRenderPatch(
        child,
        (render) =>
            function (this: RenderableInstance, width: number): string[] {
                if (!active || gate.depth === 0) return render.call(this, width);

                let styles = gate.styles.at(-1);
                if (isThinking) styles = THINKING_HIGHLIGHT_STYLES;
                if (styles === undefined) return render.call(this, width);
                if (isThinking) thinking.active += 1;

                try {
                    const lines = render.call(this, width);

                    return cache.render(this, lines, styles, () =>
                        highlightMessageLines(lines, styles),
                    );
                } finally {
                    if (isThinking) thinking.active -= 1;
                }
            },
    );

    return {
        ...patch,
        dispose(): void {
            // An opaque replacement can retain the old function without taking
            // part in linked rewiring. Retire its behavior before unlinking it.
            active = false;
            patch.dispose();
        },
    };
}

function patchAssistantContainer(
    container: Container,
    gate: AssistantRenderGate,
    thinking: { active: number },
    cache: HighlightRenderCache,
    childDisposals: WeakChildPatchDisposals,
): DisposablePatch {
    let active = true;
    const children = new WeakRenderPatches();
    const visibleMethods = new WeakMap<RenderableInstance, WeakRef<RenderableInstance["render"]>>();
    let snapshot: Array<WeakRef<RenderableInstance>> = [];
    const synchronize = (): void => {
        if (!active) return;

        if (
            snapshot.length === container.children.length &&
            snapshot.every((reference, index) => {
                const child = container.children[index];
                return (
                    reference.deref() === child &&
                    visibleMethods.get(child)?.deref() === child.render
                );
            })
        )
            return;

        children.retain(container.children);

        for (const child of container.children) {
            const observed = visibleMethods.get(child);
            if (observed !== undefined && observed.deref() !== child.render) children.remove(child);

            children.install(child, () =>
                childDisposals.track(child, patchAssistantChild(child, gate, thinking, cache)),
            );

            // oxlint-disable-next-line typescript/unbound-method -- Store weak method identity only, never invoke it unbound.
            visibleMethods.set(child, new WeakRef(child.render));
        }

        snapshot = container.children.map((child) => new WeakRef(child));
    };

    const containerPatch = installLinkedRenderPatch(
        container,
        (render) =>
            function (this: Container, width: number) {
                if (!active || gate.styles.length === 0) return render.call(this, width);

                // Predecessors may replace/add children during assistant
                // rendering. Discover them at the actual layout boundary.
                synchronize();
                gate.depth += 1;

                try {
                    return render.call(this, width);
                } finally {
                    gate.depth -= 1;
                    synchronize();
                }
            },
    );
    const mutations: Array<{ dispose(): void }> = [];

    try {
        for (const key of ["addChild", "removeChild", "clear"] as const) {
            mutations.push(
                installLinkedMethodPatch(
                    container,
                    key,
                    (mutate) =>
                        function (this: Container, ...args) {
                            if (!active) return mutate.apply(this, args);
                            try {
                                return mutate.apply(this, args);
                            } finally {
                                // SDK streaming clears then adds all children. Defer
                                // additions to the layout boundary, except while an
                                // in-progress layout can visit the new child now.
                                if (key !== "addChild" || gate.depth > 0) synchronize();
                            }
                        },
                ),
            );
        }
    } catch (cause) {
        active = false;

        for (const mutation of mutations) mutation.dispose();
        children.dispose();
        containerPatch.dispose();

        throw cause;
    }

    return {
        dispose(): void {
            active = false;

            for (const mutation of mutations) mutation.dispose();
            children.dispose();
            containerPatch.dispose();
        },
    };
}

function patchAssistantPrototype(
    prototype: RenderablePrototype,
    getStyles: HighlightStylesProvider,
    thinking: { active: number },
    cache: HighlightRenderCache,
    webCache: HighlightRenderCache,
): RenderPatchHandle {
    let active = true;
    const containers = new WeakRenderPatches();
    const visibleMethods = new WeakMap<Container, WeakRef<Container["render"]>>();
    const childDisposals = new WeakChildPatchDisposals();
    const gates = new WeakMap<Container, AssistantRenderGate>();
    const patch = installLinkedRenderPatch(
        prototype,
        (predecessor) =>
            function highlightedAssistantRender(this: RenderableInstance, width: number): string[] {
                if (!active) return predecessor.call(this, width);
                return cache.renderFrame(this, () =>
                    webCache.renderFrame(this, () => {
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

                        const container = this.contentContainer;
                        const gate = gates.get(container) ?? { styles: [], depth: 0 };
                        gates.set(container, gate);

                        const observed = visibleMethods.get(container)?.deref();
                        if (observed !== container.render) containers.remove(container);

                        containers.install(container, () =>
                            patchAssistantContainer(
                                container,
                                gate,
                                thinking,
                                cache,
                                childDisposals,
                            ),
                        );

                        if (observed !== container.render) {
                            // oxlint-disable-next-line typescript/unbound-method -- Observe weak method identity only.
                            visibleMethods.set(container, new WeakRef(container.render));
                        }

                        // Snapshot once per assistant frame, before any predecessor or
                        // child side effects. Nested frames restore the prior policy.
                        gate.styles.push(getStyles());

                        try {
                            return predecessor.call(this, width);
                        } finally {
                            gate.styles.pop();
                        }
                    }),
                );
            },
    );

    return {
        ...patch,
        dispose(): void {
            active = false;
            containers.dispose();
            childDisposals.dispose();
            patch.dispose();
        },
    };
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
                            if (disposed || thinking.active > 0) return lines;

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
