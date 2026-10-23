import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
    AssistantMessageComponent,
    BashExecutionComponent,
    SkillInvocationMessageComponent,
    ToolExecutionComponent,
    UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, visibleWidth, type Component } from "@earendil-works/pi-tui";
import ansiStyles from "ansi-styles";
import { TRANSCRIPT_PRESENTATION } from "@zigai/pi-extension-internals";
import { hasNonWhitespaceText } from "../../text-boundaries.ts";

const ASSISTANT_SEPARATOR_PATCH_STATE_KEY = Symbol.for("zigai.pi-glowup.assistant-separator.state");
const CHAT_TRANSITION_PATCH_STATE_KEY = Symbol.for(
    "zigai.pi-glowup.chat-transition-separator.state",
);
const ASSISTANT_SEPARATOR_RENDER_KEY = Symbol.for("zigai.pi-glowup.assistant-separator.render");

type AssistantContent = {
    readonly type: string;
    readonly text?: string;
    readonly thinking?: string;
};

type AssistantMessageLike = Pick<AssistantMessage, "content">;
type AssistantContentKind = "text" | "thinking";
type AssistantAddChildCall = AssistantContentKind | "other";

type AssistantRenderInstance = {
    readonly contentContainer?: unknown;
    [ASSISTANT_SEPARATOR_RENDER_KEY]?: boolean;
};

type AssistantSeparatorPatchState = {
    enabled: boolean;
    readonly originalRender: AssistantRenderPrototype["render"];
    readonly originalUpdateContent: AssistantRenderPrototype["updateContent"];
    readonly wrapperRender?: NonNullable<AssistantRenderPrototype["render"]>;
    readonly wrapperUpdateContent?: NonNullable<AssistantRenderPrototype["updateContent"]>;
};

type AssistantRenderPrototype = {
    render?: AssistantMessageComponent["render"];
    updateContent?: AssistantMessageComponent["updateContent"];
    [ASSISTANT_SEPARATOR_PATCH_STATE_KEY]?: AssistantSeparatorPatchState;
};

type ChatComponentKind = "assistant" | "tool" | "user";
type ChatContainerInstance = Container;

type ChatTransitionPatchState = {
    enabled: boolean;
    readonly originalRender: ChatContainerPrototype["render"];
    readonly wrapperRender?: NonNullable<ChatContainerPrototype["render"]>;
    readonly originalPrepare: ChatContainerPrototype[typeof TRANSCRIPT_PRESENTATION];
    readonly wrapperPrepare: NonNullable<ChatContainerPrototype[typeof TRANSCRIPT_PRESENTATION]>;
};

type ChatContainerPrototype = {
    render?: (this: ChatContainerInstance, width: number) => string[];
    [TRANSCRIPT_PRESENTATION]?: (this: ChatContainerInstance) => void;
    [CHAT_TRANSITION_PATCH_STATE_KEY]?: ChatTransitionPatchState;
};

type AssistantPrototypeOwner =
    | typeof AssistantMessageComponent.prototype
    | AssistantRenderPrototype;

type ChatContainerPrototypeOwner = typeof Container.prototype | ChatContainerPrototype;

function renderSeparator(width: number): string {
    return `${ansiStyles.modifier.dim.open}${"─".repeat(Math.max(1, Math.floor(width)))}${ansiStyles.modifier.reset.open}`;
}

function startsWithBlankLine(lines: readonly string[]): boolean {
    const [firstLine] = lines;
    return firstLine !== undefined && visibleWidth(firstLine.trim()) === 0;
}

function linesWithSeparatorSpacing(lines: readonly string[], width: number): string[] {
    const contentLines = startsWithBlankLine(lines) ? [...lines] : ["", ...lines];
    return ["", renderSeparator(width), ...contentLines];
}

function isVisibleTextContent(content: AssistantContent): boolean {
    return (
        content.type === "text" && content.text !== undefined && hasNonWhitespaceText(content.text)
    );
}

function isVisibleThinkingContent(content: AssistantContent): boolean {
    return (
        content.type === "thinking" &&
        content.thinking !== undefined &&
        hasNonWhitespaceText(content.thinking)
    );
}

function visibleContentKind(content: AssistantContent): AssistantContentKind | undefined {
    if (isVisibleTextContent(content)) {
        return "text";
    }

    if (isVisibleThinkingContent(content)) {
        return "thinking";
    }

    return undefined;
}

function visibleContentKinds(
    contentItems: ReadonlyArray<AssistantContent>,
): ReadonlyArray<AssistantContentKind | undefined> {
    return contentItems.map(visibleContentKind);
}

function hasVisibleContentAfterByIndex(
    kinds: ReadonlyArray<AssistantContentKind | undefined>,
): ReadonlyArray<boolean> {
    const hasVisibleAfter = Array.from({ length: kinds.length }, () => false);
    let hasLaterVisibleContent = false;
    for (let index = kinds.length - 1; index >= 0; index -= 1) {
        hasVisibleAfter[index] = hasLaterVisibleContent;

        if (kinds[index] !== undefined) {
            hasLaterVisibleContent = true;
        }
    }

    return hasVisibleAfter;
}

function assistantAddChildCalls(message: AssistantMessageLike): AssistantAddChildCall[] {
    const calls: AssistantAddChildCall[] = [];
    const kinds = visibleContentKinds(message.content);
    const hasVisibleContent = kinds.some((kind) => kind !== undefined);
    const hasVisibleAfter = hasVisibleContentAfterByIndex(kinds);

    if (hasVisibleContent) {
        calls.push("other");
    }

    for (let index = 0; index < kinds.length; index += 1) {
        if (message.content[index]?.type === "thinking") {
            let visibleRun = kinds[index] === "thinking";
            while (message.content[index + 1]?.type === "thinking") {
                index += 1;
                visibleRun ||= kinds[index] === "thinking";
            }

            if (visibleRun) {
                calls.push("thinking");

                if (hasVisibleAfter[index] === true) calls.push("other");
            }
        } else if (kinds[index] === "text") {
            calls.push("text");
        }
    }

    return calls;
}

function shouldRenderAssistantSeparator(previousKind: ChatComponentKind | undefined): boolean {
    return previousKind === "tool";
}

function componentKind(component: Component): ChatComponentKind | undefined {
    if (component instanceof AssistantMessageComponent) {
        return "assistant";
    }

    if (
        component instanceof ToolExecutionComponent ||
        component instanceof BashExecutionComponent
    ) {
        return "tool";
    }

    if (
        component instanceof UserMessageComponent ||
        component instanceof SkillInvocationMessageComponent
    ) {
        return "user";
    }

    return undefined;
}

function markAssistantSeparator(component: Component, shouldRender: boolean): void {
    Reflect.set(component, ASSISTANT_SEPARATOR_RENDER_KEY, shouldRender);
}

function createChatTransitionSeparatorWrapper(
    originalRender: NonNullable<ChatContainerPrototype["render"]>,
    prepare: NonNullable<ChatContainerPrototype[typeof TRANSCRIPT_PRESENTATION]>,
): NonNullable<ChatContainerPrototype["render"]> {
    return function renderWithChatTransitionSeparator(
        this: ChatContainerInstance,
        width: number,
    ): string[] {
        prepare.call(this);
        return originalRender.call(this, width);
    };
}

function createThinkingBlockSpacingWrapper(
    originalUpdateContent: NonNullable<AssistantRenderPrototype["updateContent"]>,
    isEnabled: () => boolean,
): NonNullable<AssistantRenderPrototype["updateContent"]> {
    return function updateContentWithThinkingSpacing(
        this: AssistantRenderInstance,
        message: AssistantMessage,
        isStreaming?: boolean,
    ): void {
        if (!isEnabled()) {
            originalUpdateContent.call(this, message, isStreaming);
            return;
        }

        const contentContainer = this.contentContainer;
        if (!(contentContainer instanceof Container)) {
            originalUpdateContent.call(this, message, isStreaming);
            return;
        }

        // oxlint-disable-next-line typescript/unbound-method -- SAFETY: Saved for restoration and called only with contentContainer as this.
        const originalAddChild = contentContainer.addChild;
        const addChildBeforePatch = (component: Component): void => {
            originalAddChild.call(contentContainer, component);
        };

        const calls = assistantAddChildCalls(message);
        let callIndex = 0;
        let previousVisibleKind: AssistantContentKind | undefined;

        contentContainer.addChild = function addChildWithThinkingSpacing(
            this: Container,
            component: Component,
        ): void {
            const call = calls[callIndex];
            callIndex += 1;

            if (call === "thinking" && previousVisibleKind === "text") {
                addChildBeforePatch(new Spacer(1));
            }

            addChildBeforePatch(component);

            if (call === "text" || call === "thinking") {
                previousVisibleKind = call;
            }
        };

        try {
            originalUpdateContent.call(this, message, isStreaming);
        } finally {
            contentContainer.addChild = originalAddChild;
        }
    };
}

/** Enables or disables the assistant separator prototype patches. */
export function configureAssistantSeparatorPatch(
    enabled: boolean,
    prototype: AssistantPrototypeOwner = AssistantMessageComponent.prototype,
    containerPrototype: ChatContainerPrototypeOwner = Container.prototype,
): void {
    const assistantPrototype: AssistantRenderPrototype = prototype;
    const container: ChatContainerPrototype = containerPrototype;

    if (!enabled) {
        restoreAssistantSeparatorPatch(assistantPrototype);
        restoreChatTransitionPatch(container);
        return;
    }

    installAssistantPrototypePatch(assistantPrototype);
    installChatPrototypePatch(container);
}

function installAssistantPrototypePatch(assistantPrototype: AssistantRenderPrototype): void {
    const existingState = assistantPrototype[ASSISTANT_SEPARATOR_PATCH_STATE_KEY];
    if (existingState !== undefined) {
        existingState.enabled = true;
        return;
    }

    const originalRender = assistantPrototype.render;
    const originalUpdateContent = assistantPrototype.updateContent;
    let nextState: AssistantSeparatorPatchState;
    const wrapperRender =
        originalRender !== undefined
            ? function renderWithAssistantSeparator(
                  this: AssistantRenderInstance,
                  width: number,
              ): string[] {
                  const lines = originalRender.call(this, width);
                  if (
                      !nextState.enabled ||
                      lines.length === 0 ||
                      this[ASSISTANT_SEPARATOR_RENDER_KEY] !== true
                  ) {
                      return lines;
                  }

                  return linesWithSeparatorSpacing(lines, width);
              }
            : undefined;
    const wrapperUpdateContent =
        originalUpdateContent !== undefined
            ? createThinkingBlockSpacingWrapper(originalUpdateContent, () => nextState.enabled)
            : undefined;

    if (wrapperRender !== undefined) {
        assistantPrototype.render = wrapperRender;
    }

    if (wrapperUpdateContent !== undefined) {
        assistantPrototype.updateContent = wrapperUpdateContent;
    }

    nextState = {
        enabled: true,
        originalRender,
        originalUpdateContent,
    };
    if (wrapperRender !== undefined) {
        nextState = { ...nextState, wrapperRender };
    }

    if (wrapperUpdateContent !== undefined) {
        nextState = { ...nextState, wrapperUpdateContent };
    }

    assistantPrototype[ASSISTANT_SEPARATOR_PATCH_STATE_KEY] = nextState;
}

function installChatPrototypePatch(container: ChatContainerPrototype): void {
    const existingState = container[CHAT_TRANSITION_PATCH_STATE_KEY];
    if (existingState !== undefined) {
        existingState.enabled = true;
        return;
    }

    const originalRender = container.render;
    const originalPrepare = container[TRANSCRIPT_PRESENTATION];
    let nextState: ChatTransitionPatchState;
    const wrapperPrepare = function (this: ChatContainerInstance): void {
        originalPrepare?.call(this);

        if (!nextState.enabled) return;

        let previousKind: ChatComponentKind | undefined;
        for (const component of this.children) {
            const kind = componentKind(component);
            if (kind === "assistant")
                markAssistantSeparator(component, shouldRenderAssistantSeparator(previousKind));

            if (kind !== undefined) previousKind = kind;
        }
    };
    const wrapperRender =
        originalRender !== undefined
            ? createChatTransitionSeparatorWrapper(originalRender, wrapperPrepare)
            : undefined;

    container[TRANSCRIPT_PRESENTATION] = wrapperPrepare;
    if (wrapperRender !== undefined) {
        container.render = wrapperRender;
    }

    nextState = {
        enabled: true,
        originalRender,
        originalPrepare,
        wrapperPrepare,
    };
    if (wrapperRender !== undefined) {
        nextState = { ...nextState, wrapperRender };
    }

    container[CHAT_TRANSITION_PATCH_STATE_KEY] = nextState;
}

function restoreAssistantSeparatorPatch(assistantPrototype: AssistantRenderPrototype): void {
    const state = assistantPrototype[ASSISTANT_SEPARATOR_PATCH_STATE_KEY];
    if (state === undefined) {
        return;
    }

    state.enabled = false;
    if (
        (state.wrapperRender !== undefined && assistantPrototype.render !== state.wrapperRender) ||
        (state.wrapperUpdateContent !== undefined &&
            assistantPrototype.updateContent !== state.wrapperUpdateContent)
    )
        return;

    if (state.wrapperRender !== undefined) {
        restoreAssistantMethod(assistantPrototype, "render", state.originalRender);
    }

    if (state.wrapperUpdateContent !== undefined) {
        restoreAssistantMethod(assistantPrototype, "updateContent", state.originalUpdateContent);
    }

    delete assistantPrototype[ASSISTANT_SEPARATOR_PATCH_STATE_KEY];
}

function restoreChatTransitionPatch(container: ChatContainerPrototype): void {
    const state = container[CHAT_TRANSITION_PATCH_STATE_KEY];
    if (state === undefined) {
        return;
    }

    state.enabled = false;
    if (
        container[TRANSCRIPT_PRESENTATION] !== state.wrapperPrepare ||
        (state.wrapperRender !== undefined && container.render !== state.wrapperRender)
    )
        return;

    if (state.originalPrepare === undefined) delete container[TRANSCRIPT_PRESENTATION];
    else container[TRANSCRIPT_PRESENTATION] = state.originalPrepare;

    if (state.wrapperRender !== undefined) {
        if (state.originalRender === undefined) {
            delete container.render;
        } else {
            container.render = state.originalRender;
        }
    }

    delete container[CHAT_TRANSITION_PATCH_STATE_KEY];
}

function restoreAssistantMethod<TName extends "render" | "updateContent">(
    prototype: AssistantRenderPrototype,
    methodName: TName,
    method: AssistantRenderPrototype[TName],
): void {
    if (method === undefined) {
        delete prototype[methodName];
        return;
    }

    prototype[methodName] = method;
}
