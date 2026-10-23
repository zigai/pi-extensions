import type { AssistantMessage } from "@earendil-works/pi-ai";
import { installTableRendering, type TableStyle } from "./table-patch.ts";
import { Markdown, type Component } from "@earendil-works/pi-tui";
import {
    installLinkedRenderPatch,
    installLinkedMethodPatch,
    warnPiInternalPatchUnavailable,
    type LinkedMethodPatchHandle,
} from "@zigai/pi-extension-internals";

import {
    assistantMessageRuntime,
    type AssistantMessageComponentInstance,
    type AssistantMessageComponentPrototype,
} from "./assistant-message-runtime.ts";

import {
    collapseAssistantBlankLines,
    getTableBoundaryLineTexts,
    isFenceLine,
    markFencesHidden,
    resolveHeadingLineTexts,
    resolveHeadingPrefix,
    shouldHideFences,
    stripItalicAnsi,
} from "./markdown-rendering.ts";

const MARKDOWN_FENCES_PATCH_KEY = Symbol.for("zigai.pi-ui-tweaks.markdown-fences-patched");
const SCOPE = "pi-response-renderer";

type RenderFrame = {
    readonly width: number;
    readonly source: readonly string[];
    readonly output: string[];
};

type MarkdownFrame = RenderFrame & {
    readonly fencesHidden: boolean;
};

function sameRenderFrame(frame: RenderFrame, width: number, lines: readonly string[]): boolean {
    return (
        frame.width === width &&
        frame.source.length === lines.length &&
        lines.every((line, index) => line === frame.source[index])
    );
}

type ForeignMarkdownPatch = {
    component: Component;
    handle: LinkedMethodPatchHandle<Component, [width: number], string[]>;
};

function hasForeignMarkdownContract(component: Component): boolean {
    return (
        "setText" in component &&
        typeof component.setText === "function" &&
        "invalidate" in component &&
        typeof component.invalidate === "function" &&
        "text" in component &&
        "theme" in component
    );
}

function hideForeignMarkdownFences(patch: MarkdownFencesPatchRecord, component: Component): void {
    const foreignMarkdownPatches = patch.foreignMarkdownPatches;
    if (foreignMarkdownPatches.some((entry) => entry.component === component)) return;

    const handle = installLinkedRenderPatch(component, (predecessor) => {
        let frame: RenderFrame | undefined;
        return function (this: Component, width: number): string[] {
            const source = predecessor.call(this, width);
            if (frame !== undefined && sameRenderFrame(frame, width, source)) return frame.output;

            const lines = source.filter((line) => !isFenceLine(line));
            const output = collapseAssistantBlankLines(lines, "", new Set());
            frame = { width, source: [...source], output };
            return output;
        };
    });

    foreignMarkdownPatches.push({ component, handle });
}

function hideAssistantMarkdownFences(patch: MarkdownFencesPatchRecord, component: Component): void {
    if (component instanceof Markdown) {
        markFencesHidden(component);
        return;
    }

    if (hasForeignMarkdownContract(component)) hideForeignMarkdownFences(patch, component);
}

type AssistantRenderPatchHandle = LinkedMethodPatchHandle<
    AssistantMessageComponentInstance,
    [width: number],
    string[]
>;

type MarkdownFencesPatchRecord = {
    readonly owners: Set<symbol>;
    markdownRenderPatch?: LinkedMethodPatchHandle<Markdown, [width: number], string[]>;
    foreignMarkdownPatches: ForeignMarkdownPatch[];
    assistantRenderPatch?: AssistantRenderPatchHandle;

    assistantUpdatePatch?: LinkedMethodPatchHandle<
        AssistantMessageComponentPrototype,
        [message: AssistantMessage, isStreaming?: boolean],
        void
    >;
};

type PatchState = typeof globalThis & {
    [MARKDOWN_FENCES_PATCH_KEY]?: MarkdownFencesPatchRecord;
};

function restoreMarkdownFencesPatch(patch: MarkdownFencesPatchRecord, owner: symbol): void {
    const state: PatchState = globalThis;
    patch.owners.delete(owner);

    if (patch.owners.size > 0 || state[MARKDOWN_FENCES_PATCH_KEY] !== patch) return;

    patch.markdownRenderPatch?.dispose();

    for (const foreignPatch of patch.foreignMarkdownPatches) foreignPatch.handle.dispose();
    patch.foreignMarkdownPatches.length = 0;

    patch.assistantRenderPatch?.dispose();

    patch.assistantUpdatePatch?.dispose();

    delete state[MARKDOWN_FENCES_PATCH_KEY];
}

async function patchMarkdownFences(owner: symbol): Promise<MarkdownFencesPatchRecord | undefined> {
    const state: PatchState = globalThis;
    const assistantComponent = assistantMessageRuntime.parse(
        await import("@earendil-works/pi-coding-agent"),
    );
    if (assistantComponent === undefined) {
        warnPiInternalPatchUnavailable(SCOPE, "assistant message patch");
        return undefined;
    }

    const existing = state[MARKDOWN_FENCES_PATCH_KEY];
    if (existing !== undefined) {
        existing.owners.add(owner);
        return existing;
    }

    const patch: MarkdownFencesPatchRecord = {
        owners: new Set([owner]),
        foreignMarkdownPatches: [],
    };
    const markdownFrames = new WeakMap<Markdown, MarkdownFrame>();
    const assistantFrames = new WeakMap<AssistantMessageComponentInstance, RenderFrame>();

    patch.markdownRenderPatch = installLinkedRenderPatch(
        Markdown.prototype,
        (predecessor) =>
            function (this: Markdown, width: number) {
                const source = predecessor.call(this, width);
                const fencesHidden = shouldHideFences(this);
                const frame = markdownFrames.get(this);
                if (
                    frame?.source === source &&
                    frame.width === width &&
                    frame.fencesHidden === fencesHidden
                ) {
                    return frame.output;
                }

                let lines = source;

                if (fencesHidden) lines = lines.filter((line) => !isFenceLine(line));

                const output = collapseAssistantBlankLines(
                    lines,
                    resolveHeadingPrefix(this),
                    resolveHeadingLineTexts(this, width, predecessor),
                    getTableBoundaryLineTexts(this),
                );
                markdownFrames.set(this, { width, source, output, fencesHidden });

                return output;
            },
    );

    const assistantPrototype = assistantComponent.prototype;

    patch.assistantRenderPatch = installLinkedRenderPatch(
        assistantPrototype,
        (predecessor) =>
            function assistantRenderWithoutItalics(
                this: AssistantMessageComponentInstance,
                width: number,
            ): string[] {
                const source = predecessor.call(this, width);
                const frame = assistantFrames.get(this);
                if (frame !== undefined && sameRenderFrame(frame, width, source))
                    return frame.output;

                const output = source.map(stripItalicAnsi);
                assistantFrames.set(this, { width, source: [...source], output });

                return output;
            },
    );
    patch.assistantUpdatePatch = installLinkedMethodPatch(
        assistantPrototype,
        "updateContent",
        (predecessor) =>
            function (
                this: AssistantMessageComponentInstance,
                message: AssistantMessage,
                isStreaming?: boolean,
            ): void {
                const contentContainer = this.contentContainer;
                let childPatch: { dispose(): void } | undefined;
                if (contentContainer !== undefined) {
                    childPatch = installLinkedMethodPatch(
                        contentContainer,
                        "addChild",
                        (addChild) =>
                            function (
                                this: NonNullable<
                                    AssistantMessageComponentInstance["contentContainer"]
                                >,
                                component: Component,
                            ): void {
                                hideAssistantMarkdownFences(patch, component);
                                addChild.call(this, component);
                            },
                    );
                }

                try {
                    predecessor.call(this, message, isStreaming);
                } finally {
                    childPatch?.dispose();
                }
            },
    );
    state[MARKDOWN_FENCES_PATCH_KEY] = patch;
    return patch;
}

export async function installResponseRendering({
    tableHeaderColor = "#5CCCCC",
    nativeTableBorderStyle = "dim",
}: Partial<TableStyle> = {}) {
    const owner = Symbol();
    const markdown = await patchMarkdownFences(owner);
    let tables: ReturnType<typeof installTableRendering>;
    try {
        tables = installTableRendering({ tableHeaderColor, nativeTableBorderStyle });
    } catch (cause: unknown) {
        if (markdown !== undefined) restoreMarkdownFencesPatch(markdown, owner);
        throw cause;
    }

    let disposed = false;

    return {
        dispose(): void {
            if (disposed) return;

            disposed = true;

            try {
                tables?.dispose();
            } finally {
                if (markdown !== undefined) restoreMarkdownFencesPatch(markdown, owner);
            }
        },
    };
}
