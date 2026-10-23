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
import { revealProse, type ProseStreamingMode } from "./prose.ts";
import { displayFenceCode, markdownFences } from "./markdown-fences.ts";

export type AssistantStreamingOptions = {
    readonly prose: ProseStreamingMode;
    readonly code: CodeStreamingMode;
    readonly streams: CodeStreamStore;
    readonly formatter?: ScriptBlockFormatter | undefined;
    readonly invalidate: () => void;
};

type ComponentState = {
    key: string;
    readonly clones: WeakSet<AssistantMessage>;
    raw: AssistantMessage;
    streaming: boolean;
    dirty: boolean;
    targetWidth: number | undefined;
};

const componentConstructorSchema = Type.Object({ component: Type.Constructor([], Type.Unknown()) });
const componentPrototypeSchema = Type.Object({
    updateContent: Type.Function([], Type.Void()),
    render: Type.Function([Type.Number()], Type.Array(Type.String())),
});
const outputPaddingSchema = Type.Number({ minimum: 0 });
let nextComponent = 0;

function renderText(
    source: string,
    key: string,
    complete: boolean,
    options: AssistantStreamingOptions,
    targetWidth: number | undefined,
    invalidate: () => void,
): string {
    // Prepare every independent fence once, even while an earlier one is held.
    // Readiness can then be coalesced into one paint without requiring another
    // provider chunk or a component rebuild to start the following block.
    const previews = markdownFences(source).map((fence, index) => {
        const fenceKey = `${key}:fence:${index}`;
        let codeWidth = targetWidth;
        if (codeWidth !== undefined) codeWidth = Math.max(1, codeWidth - fence.widthInset);

        const display = options.streams.get({
            key: fenceKey,
            source: fence.code,
            language: fence.language,
            complete: complete || fence.complete,
            mode: options.code,
            formatter: options.formatter,
            targetWidth: codeWidth,
            invalidate,
        });

        return { fence, fenceKey, display };
    });
    let output = "";
    let offset = 0;
    for (const { fence, fenceKey, display } of previews) {
        const preceding = source.slice(offset, fence.start);
        const code = fence.code;

        // A fence completes ordinary preceding prose, but a trailing heading
        // belongs to its following content, not to an empty pending code block.
        const trailingHeading =
            /(?:^|\n) {0,3}#{1,6}(?:[ \t]+[^\r\n]*)?\r?\n(?:[ \t]*\r?\n)*$/u.test(preceding);
        const emptyCompleteFence = code.trim().length === 0 && (complete || fence.complete);
        if (
            options.prose === "paragraph" &&
            trailingHeading &&
            display.trim().length === 0 &&
            !emptyCompleteFence
        ) {
            return output + revealProse(preceding, options.prose, false);
        }

        output += preceding;

        // Do not display an empty placeholder or later prose ahead of a pending
        // code unit. The store's completion callback will reveal it in order.
        if (display.length === 0 && code.length > 0) return output;

        if (display.length > 0 || fence.complete || complete) {
            output += fence.opener + displayFenceCode(fence, display);
            if (fence.complete) {
                // A ready prefix is not the whole closed block. Keep its real
                // closing fence and following prose behind the remaining units.
                if (options.code !== "token" && !options.streams.ready(fenceKey)) return output;

                if (fence.closed) {
                    if (display.length > 0 && !/[\r\n]$/u.test(display)) output += "\n";
                    output += fence.closer;
                }
            }
        } else if (options.code === "token") {
            output += fence.opener;
        }

        offset = fence.end;
    }

    return output + revealProse(source.slice(offset), options.prose, complete);
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
                };
                states.set(this, state);
                components.add(new WeakRef(this));
            }

            if (!state.streaming && isStreaming === true)
                state.key = `assistant:${nextComponent++}`;

            if (!state.clones.has(message)) state.raw = message;
            if (isStreaming !== undefined) state.streaming = isStreaming;

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
                if (block.type !== "text") return block;

                return {
                    ...block,
                    text: renderText(
                        block.text,
                        `${remembered.key}:text:${index}`,
                        complete,
                        options,
                        remembered.targetWidth,
                        invalidate,
                    ),
                };
            });
            const clone: AssistantMessage = { ...raw, content };
            state.clones.add(clone);
            state.dirty = false;
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
                        const padding: unknown = Object.getOwnPropertyDescriptor(
                            this,
                            "outputPad",
                        )?.value;
                        let available = Math.floor(width);
                        if (Value.Check(outputPaddingSchema, padding))
                            available -= 2 * Math.max(0, padding);
                        available = Math.max(1, Math.floor(available - codeIndentWidth));
                        if (state.targetWidth !== available || state.dirty) {
                            state.targetWidth = available;
                            this.updateContent(state.raw, state.streaming);
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
