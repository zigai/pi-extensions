import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Markdown, type Component } from "@earendil-works/pi-tui";
import {
    installLinkedRenderPatch,
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
    isFenceLine,
    markFencesHidden,
    resolveHeadingLineTexts,
    resolveHeadingPrefix,
    shouldHideFences,
    stripItalicAnsi,
    type MarkdownRender,
} from "./markdown-rendering.ts";

const MARKDOWN_FENCES_PATCH_KEY = Symbol.for("zigai.pi-ui-tweaks.markdown-fences-patched");
const SCOPE = "pi-response-renderer";

type ForeignMarkdownPatch = {
    component: Component;
    originalRender: Component["render"];
    patchedRender: Component["render"];
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
    if (foreignMarkdownPatches === undefined) return;
    if (foreignMarkdownPatches.some((entry) => entry.component === component)) return;

    // Stored for identity-safe restoration and always invoked with its original receiver.
    // oxlint-disable-next-line typescript/unbound-method
    const originalRender = component.render;
    const patchedRender = function renderWithoutFences(width: number): string[] {
        const lines = originalRender.call(component, width).filter((line) => !isFenceLine(line));
        return collapseAssistantBlankLines(lines, "", new Set());
    };

    component.render = patchedRender;
    foreignMarkdownPatches.push({ component, originalRender, patchedRender });
}

function hideAssistantMarkdownFences(patch: MarkdownFencesPatchRecord, component: Component): void {
    if (component instanceof Markdown) {
        markFencesHidden(component);
        return;
    }

    if (hasForeignMarkdownContract(component)) hideForeignMarkdownFences(patch, component);
}

type MarkdownPrototype = { render?: MarkdownRender };

type AssistantRenderPatchHandle = LinkedMethodPatchHandle<
    AssistantMessageComponentInstance,
    [width: number],
    string[]
>;

type MarkdownFencesPatchRecord = {
    markdownPrototype: MarkdownPrototype;
    originalMarkdownRender: MarkdownRender;
    patchedMarkdownRender: MarkdownRender;
    foreignMarkdownPatches?: ForeignMarkdownPatch[];
    assistantRenderPatch?: AssistantRenderPatchHandle;
    assistantPrototype?: AssistantMessageComponentPrototype;
    originalAssistantUpdateContent?: AssistantMessageComponentPrototype["updateContent"];
    patchedAssistantUpdateContent?: AssistantMessageComponentPrototype["updateContent"];
};

type PatchState = typeof globalThis & {
    [MARKDOWN_FENCES_PATCH_KEY]?: MarkdownFencesPatchRecord | true;
};

function restoreMarkdownFencesPatch(): void {
    const state: PatchState = globalThis;
    const patch = state[MARKDOWN_FENCES_PATCH_KEY];
    if (patch === undefined || patch === true) return;

    if (patch.markdownPrototype.render === patch.patchedMarkdownRender) {
        patch.markdownPrototype.render = patch.originalMarkdownRender;
    }

    const foreignMarkdownPatches = patch.foreignMarkdownPatches;
    if (foreignMarkdownPatches !== undefined) {
        for (const foreignPatch of foreignMarkdownPatches) {
            if (foreignPatch.component.render === foreignPatch.patchedRender) {
                foreignPatch.component.render = foreignPatch.originalRender;
            }
        }

        foreignMarkdownPatches.length = 0;
    }

    patch.assistantRenderPatch?.dispose();

    if (
        patch.assistantPrototype !== undefined &&
        patch.originalAssistantUpdateContent !== undefined &&
        patch.patchedAssistantUpdateContent !== undefined &&
        patch.assistantPrototype.updateContent === patch.patchedAssistantUpdateContent
    ) {
        patch.assistantPrototype.updateContent = patch.originalAssistantUpdateContent;
    }

    delete state[MARKDOWN_FENCES_PATCH_KEY];
}

async function patchMarkdownFences(): Promise<void> {
    const state: PatchState = globalThis;
    if (state[MARKDOWN_FENCES_PATCH_KEY] !== undefined) return;

    const markdownPrototype: MarkdownPrototype = Markdown.prototype;
    const originalMarkdownRender = markdownPrototype.render;
    if (typeof originalMarkdownRender !== "function") {
        warnPiInternalPatchUnavailable(SCOPE, "markdown render patch");
        return;
    }

    const patchedMarkdownRender: MarkdownRender = function (this: Markdown, width: number) {
        let lines = originalMarkdownRender.call(this, width);
        if (shouldHideFences(this)) lines = lines.filter((line) => !isFenceLine(line));
        return collapseAssistantBlankLines(
            lines,
            resolveHeadingPrefix(this),
            resolveHeadingLineTexts(this, width, originalMarkdownRender),
        );
    };

    markdownPrototype.render = patchedMarkdownRender;

    const patch: MarkdownFencesPatchRecord = {
        markdownPrototype,
        originalMarkdownRender,
        patchedMarkdownRender,
        foreignMarkdownPatches: [],
    };
    state[MARKDOWN_FENCES_PATCH_KEY] = patch;

    // The public export resolves to Pi's active bundle in a running TUI.
    const assistantComponent = assistantMessageRuntime.parse(
        await import("@earendil-works/pi-coding-agent"),
    );
    if (assistantComponent === undefined) {
        warnPiInternalPatchUnavailable(SCOPE, "assistant message patch");
        return;
    }

    const assistantPrototype = assistantComponent.prototype;

    patch.assistantRenderPatch = installLinkedRenderPatch(
        assistantPrototype,
        (predecessor) =>
            function assistantRenderWithoutItalics(
                this: AssistantMessageComponentInstance,
                width: number,
            ): string[] {
                return predecessor.call(this, width).map(stripItalicAnsi);
            },
    );
    patch.assistantPrototype = assistantPrototype;

    const originalUpdateContent = assistantPrototype.updateContent;
    const patchedAssistantUpdateContent = function (
        this: AssistantMessageComponentInstance,
        message: AssistantMessage,
        isStreaming?: boolean,
    ): void {
        const contentContainer = this.contentContainer;
        const originalAddChild = contentContainer?.addChild;
        if (contentContainer !== undefined && originalAddChild !== undefined) {
            contentContainer.addChild = function (
                this: NonNullable<AssistantMessageComponentInstance["contentContainer"]>,
                component: Component,
            ): void {
                hideAssistantMarkdownFences(patch, component);
                originalAddChild.call(this, component);
            };
        }

        try {
            originalUpdateContent.call(this, message, isStreaming);
        } finally {
            if (contentContainer !== undefined && originalAddChild !== undefined) {
                contentContainer.addChild = originalAddChild;
            }
        }
    };

    assistantPrototype.updateContent = patchedAssistantUpdateContent;
    patch.originalAssistantUpdateContent = originalUpdateContent;
    patch.patchedAssistantUpdateContent = patchedAssistantUpdateContent;
}

type ShutdownRegistration = {
    on(event: "session_shutdown", handler: () => void): void;
};

export default async function assistantRenderingExtension(
    pi?: ShutdownRegistration,
): Promise<void> {
    await patchMarkdownFences();
    pi?.on("session_shutdown", restoreMarkdownFencesPatch);
}
