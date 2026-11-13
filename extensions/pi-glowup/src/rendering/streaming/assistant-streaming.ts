import type { AssistantMessage } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import Type from "typebox";
import { Value } from "typebox/value";
import type { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import {
    installLinkedMethodPatch,
    warnPiInternalPatchUnavailable,
} from "@zigai/pi-extension-internals";
import type { ScriptBlockFormatter } from "../../tools/built-in/bash/formatter.ts";
import type { CodeStreamingMode, CodeStreamStore } from "./code-stream.ts";
import type { ProseStreamingMode } from "./prose.ts";
import { createStreamingPresentation } from "./content-presentation.ts";
import type { GlowupStreamingPolicy } from "../../tools/protocol/streaming.ts";

export type AssistantStreamingOptions = {
    readonly prose: ProseStreamingMode;
    readonly code: CodeStreamingMode;
    readonly streams: CodeStreamStore;
    readonly formatter?: ScriptBlockFormatter | undefined;
    readonly invalidate: () => void;
    readonly presentation?: Pick<GlowupStreamingPolicy, "present">;
};

type ComponentState = {
    key: string;
    readonly clones: WeakSet<AssistantMessage>;
    raw: AssistantMessage;
    streaming: boolean;
    dirty: boolean;
    targetWidth: number | undefined;
    renderWidth: number | undefined;
    refreshing: boolean;
    presented: Presentation | undefined;
};

// What Pi last received: the raw message, its streaming flag, and each displayed text.
type Presentation = {
    readonly raw: AssistantMessage;
    readonly streaming: boolean;
    readonly texts: readonly (string | undefined)[];
};

const componentConstructorSchema = Type.Object({ component: Type.Constructor([], Type.Unknown()) });
const outputPaddingSchema = Type.Number({ minimum: 0 });
const componentPrototypeSchema = Type.Object({
    updateContent: Type.Function([], Type.Void()),
    render: Type.Function([Type.Number()], Type.Array(Type.String())),
});

let nextComponent = 0;

function displayedText(block: AssistantMessage["content"][number]): string | undefined {
    if (block.type === "thinking") return block.thinking;
    if (block.type === "text") return block.text;

    return undefined;
}

function samePresentation(previous: Presentation | undefined, next: Presentation): boolean {
    return (
        previous !== undefined &&
        previous.raw === next.raw &&
        previous.streaming === next.streaming &&
        previous.texts.length === next.texts.length &&
        previous.texts.every((text, index) => text === next.texts[index])
    );
}

/**
 * Patches the exported host component before its Markdown constructor trims text.
 * Only display clones reach Pi; clone-triggered invalidations always restart from
 * the retained raw message and preserve the host's omitted streaming flag.
 */
export async function installAssistantStreaming(
    options: AssistantStreamingOptions,
): Promise<{ dispose(): void }> {
    if (options.prose === "token" && options.code === "token") return { dispose() {} };

    let host: typeof import("@earendil-works/pi-coding-agent");
    try {
        host = await import("@earendil-works/pi-coding-agent");
    } catch (error: unknown) {
        warnPiInternalPatchUnavailable("pi-glowup", "assistant structured streaming", error);

        return { dispose() {} };
    }

    const Component = host.AssistantMessageComponent;
    let codeIndentWidth: number;

    try {
        if (!Value.Check(componentConstructorSchema, { component: Component })) {
            warnPiInternalPatchUnavailable("pi-glowup", "assistant structured streaming");

            return { dispose() {} };
        }

        const updateContent: unknown = Object.getOwnPropertyDescriptor(
            Component.prototype,
            "updateContent",
        )?.value;
        const render: unknown = Object.getOwnPropertyDescriptor(
            Component.prototype,
            "render",
        )?.value;
        if (!Value.Check(componentPrototypeSchema, { updateContent, render })) {
            warnPiInternalPatchUnavailable("pi-glowup", "assistant structured streaming");

            return { dispose() {} };
        }

        codeIndentWidth = visibleWidth(host.getMarkdownTheme().codeBlockIndent ?? "  ");
    } catch (error: unknown) {
        warnPiInternalPatchUnavailable("pi-glowup", "assistant structured streaming", error);

        return { dispose() {} };
    }

    const presentation = options.presentation ?? createStreamingPresentation(() => options);
    let active = true;
    const states = new WeakMap<AssistantMessageComponent, ComponentState>();
    const components = new Set<WeakRef<AssistantMessageComponent>>();
    const patch = installLinkedMethodPatch(Component.prototype, "updateContent", (previous) => {
        return function updateStreamingContent(message, isStreaming): void {
            if (!active) {
                previous.call(this, message, isStreaming);
                return;
            }

            let state = states.get(this);
            if (state === undefined) {
                state = {
                    key: `assistant:${nextComponent++}`,
                    clones: new WeakSet(),
                    raw: message,
                    streaming: false,
                    dirty: false,
                    targetWidth: undefined,
                    renderWidth: undefined,
                    refreshing: false,
                    presented: undefined,
                };
                states.set(this, state);
                components.add(new WeakRef(this));
            }

            if (!state.streaming && isStreaming === true)
                state.key = `assistant:${nextComponent++}`;

            if (!state.clones.has(message)) state.raw = message;
            if (isStreaming !== undefined) state.streaming = isStreaming;

            // Host-initiated updates may change the output padding behind the render width.
            if (!state.refreshing) state.renderWidth = undefined;

            const raw = state.raw;
            if (["aborted", "error", "length"].includes(raw.stopReason)) state.streaming = false;

            const complete = !state.streaming;
            const remembered = state;
            const invalidate = (): void => {
                if (!active) return;

                // Async units request the existing TUI paint without rebuilding
                // the host component (or retaining it) for every ready statement.
                remembered.dirty = true;
                options.invalidate();
            };

            const content = raw.content.map((block, index) => {
                // Providers append blocks in generation order. Once another block
                // starts, this one's unpunctuated tail is no longer speculative.
                const blockComplete = complete || index < raw.content.length - 1;
                if (block.type === "thinking") {
                    return {
                        ...block,
                        thinking: presentation.present({
                            key: `${remembered.key}:thinking:${index}`,
                            kind: "markdown",
                            source: block.thinking,
                            complete: blockComplete,
                            ...(remembered.targetWidth !== undefined && {
                                targetWidth: remembered.targetWidth,
                            }),
                            invalidate,
                        }),
                    };
                }

                if (block.type !== "text") return block;

                return {
                    ...block,
                    text: presentation.present({
                        key: `${remembered.key}:text:${index}`,
                        kind: "markdown",
                        source: block.text,
                        complete: blockComplete,
                        ...(remembered.targetWidth !== undefined && {
                            targetWidth: remembered.targetWidth,
                        }),
                        invalidate,
                    }),
                };
            });
            const presented: Presentation = {
                raw,
                streaming: state.streaming,
                texts: content.map(displayedText),
            };

            state.dirty = false;

            // A width change or async readiness that leaves every displayed text unchanged
            // would only rebuild identical children and discard their rendered lines.
            if (state.refreshing && samePresentation(state.presented, presented)) return;

            const clone: AssistantMessage = { ...raw, content };
            state.clones.add(clone);
            state.presented = presented;
            previous.call(this, clone, state.streaming);
        };
    });
    const patches: { dispose(): void }[] = [patch];

    try {
        patches.push(
            installLinkedMethodPatch(Component.prototype, "render", (previous) => {
                return function renderStreamingContent(width): string[] {
                    const state = states.get(this);
                    if (active && state !== undefined && Number.isFinite(width)) {
                        if (state.renderWidth !== width) {
                            state.renderWidth = width;

                            const padding: unknown = Object.getOwnPropertyDescriptor(
                                this,
                                "outputPad",
                            )?.value;
                            let available = Math.floor(width);
                            if (Value.Check(outputPaddingSchema, padding))
                                available -= 2 * Math.max(0, padding);
                            available = Math.max(1, Math.floor(available - codeIndentWidth));
                            if (state.targetWidth !== available) {
                                state.targetWidth = available;
                                state.dirty = true;
                            }
                        }

                        if (state.dirty) {
                            state.refreshing = true;

                            try {
                                this.updateContent(state.raw, state.streaming);
                            } finally {
                                state.refreshing = false;
                            }
                        }
                    }

                    return previous.call(this, width);
                };
            }),
        );
    } catch (cause: unknown) {
        active = false;
        patch.dispose();
        throw cause;
    }

    return {
        dispose(): void {
            if (!active) return;

            active = false;

            for (const handle of patches.reverse()) handle.dispose();

            // Leave no truncated display clone behind after settings/session teardown.
            for (const reference of components) {
                const component = reference.deref();
                if (component === undefined) continue;

                const state = states.get(component);
                if (state !== undefined) component.updateContent(state.raw, state.streaming);
            }

            components.clear();
        },
    };
}
