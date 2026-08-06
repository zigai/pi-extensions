import {
    AssistantMessageComponent,
    BashExecutionComponent,
    SkillInvocationMessageComponent,
    ToolExecutionComponent,
    UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, type Component, visibleWidth } from "@earendil-works/pi-tui";
import ansiStyles from "ansi-styles";
import { hasNonWhitespaceText } from "../text-boundaries.ts";

const ASSISTANT_SEPARATOR_PATCH_KEY = Symbol.for("zigai.pi-glowup.assistant-separator");
const ASSISTANT_SEPARATOR_PATCH_STATE_KEY = Symbol.for("zigai.pi-glowup.assistant-separator.state");
const CHAT_TRANSITION_PATCH_KEY = Symbol.for("zigai.pi-glowup.chat-transition-separator");
const CHAT_TRANSITION_PATCH_STATE_KEY = Symbol.for(
    "zigai.pi-glowup.chat-transition-separator.state",
);
const ASSISTANT_SEPARATOR_RENDER_KEY = Symbol.for("zigai.pi-glowup.assistant-separator.render");

type AssistantContent = {
    readonly type: string;
    readonly text?: string;
    readonly thinking?: string;
};

type AssistantMessageLike = {
    readonly content: ReadonlyArray<AssistantContent>;
};

type AssistantContentKind = "text" | "thinking";

type AssistantAddChildCall = AssistantContentKind | "other";

type AssistantContentContainer = {
    addChild(component: Component): void;
};

type AssistantRenderInstance = {
    readonly contentContainer?: AssistantContentContainer;
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
    render?: (this: AssistantRenderInstance, width: number) => string[];
    updateContent?: (this: AssistantRenderInstance, message: AssistantMessageLike) => void;
    [ASSISTANT_SEPARATOR_PATCH_KEY]?: true;
    [ASSISTANT_SEPARATOR_PATCH_STATE_KEY]?: AssistantSeparatorPatchState;
};

type ChatComponentKind = "assistant" | "tool" | "user";

type ChatContainerInstance = object;

type ChatTransitionPatchState = {
    enabled: boolean;
    readonly originalAddChild: ChatContainerPrototype["addChild"];
    readonly wrapperAddChild?: NonNullable<ChatContainerPrototype["addChild"]>;
};

type ChatContainerPrototype = {
    addChild?: (this: ChatContainerInstance, component: Component) => void;
    [CHAT_TRANSITION_PATCH_KEY]?: true;
    [CHAT_TRANSITION_PATCH_STATE_KEY]?: ChatTransitionPatchState;
};

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
        content.type === "text" &&
        typeof content.text === "string" &&
        hasNonWhitespaceText(content.text)
    );
}

function isVisibleThinkingContent(content: AssistantContent): boolean {
    return (
        content.type === "thinking" &&
        typeof content.thinking === "string" &&
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

    for (const [index, kind] of kinds.entries()) {
        if (kind === undefined) {
            continue;
        }

        calls.push(kind);
        if (kind === "thinking" && hasVisibleAfter[index] === true) {
            calls.push("other");
        }
    }
    return calls;
}

const chatComponentKinds = new WeakMap<ChatContainerInstance, ChatComponentKind>();

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
    originalAddChild: (this: ChatContainerInstance, component: Component) => void,
    isEnabled: () => boolean,
): NonNullable<ChatContainerPrototype["addChild"]> {
    return function addChildWithChatTransitionSeparator(
        this: ChatContainerInstance,
        component: Component,
    ): void {
        if (!isEnabled()) {
            originalAddChild.call(this, component);
            return;
        }

        const kind = componentKind(component);
        if (kind === "assistant") {
            markAssistantSeparator(
                component,
                shouldRenderAssistantSeparator(chatComponentKinds.get(this)),
            );
        }

        originalAddChild.call(this, component);

        if (kind !== undefined) {
            chatComponentKinds.set(this, kind);
        }
    };
}

function createThinkingBlockSpacingWrapper(
    originalUpdateContent: (this: AssistantRenderInstance, message: AssistantMessageLike) => void,
    isEnabled: () => boolean,
): NonNullable<AssistantRenderPrototype["updateContent"]> {
    return function updateContentWithThinkingSpacing(
        this: AssistantRenderInstance,
        message: AssistantMessageLike,
    ): void {
        if (!isEnabled()) {
            originalUpdateContent.call(this, message);
            return;
        }

        const contentContainer = this.contentContainer;
        if (contentContainer === undefined) {
            originalUpdateContent.call(this, message);
            return;
        }

        // oxlint-disable-next-line typescript/unbound-method -- SAFETY: The original method is restored after the temporary wrapper and is only invoked with contentContainer as this.
        const originalAddChild = contentContainer.addChild;
        const addChildBeforePatch = (component: Component): void => {
            originalAddChild.call(contentContainer, component);
        };
        const calls = assistantAddChildCalls(message);
        let callIndex = 0;
        let previousVisibleKind: AssistantContentKind | undefined;

        contentContainer.addChild = function addChildWithThinkingSpacing(
            this: AssistantContentContainer,
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
            originalUpdateContent.call(this, message);
        } finally {
            contentContainer.addChild = originalAddChild;
        }
    };
}

// SAFETY: Pi exposes the component class, but private fields hide the prototype shape from structural typing; the installer still guards every patched method at runtime.
const assistantMessagePrototype =
    AssistantMessageComponent.prototype as unknown as AssistantRenderPrototype;

const chatContainerPrototype = Container.prototype as unknown as ChatContainerPrototype;

/** Enables or disables the assistant separator prototype patches. */
export function configureAssistantSeparatorPatch(
    enabled: boolean,
    prototype: object = assistantMessagePrototype,
    containerPrototype: object = chatContainerPrototype,
): void {
    // SAFETY: This installer accepts test doubles and Pi's concrete prototype. All patched
    // members are runtime-guarded before use, and the symbol marker is local to this module.
    const assistantPrototype = prototype as AssistantRenderPrototype;
    const container = containerPrototype as ChatContainerPrototype;

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
        typeof originalRender === "function"
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
        typeof originalUpdateContent === "function"
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
        ...(wrapperRender === undefined ? {} : { wrapperRender }),
        ...(wrapperUpdateContent === undefined ? {} : { wrapperUpdateContent }),
    };
    assistantPrototype[ASSISTANT_SEPARATOR_PATCH_STATE_KEY] = nextState;
    assistantPrototype[ASSISTANT_SEPARATOR_PATCH_KEY] = true;
}

function installChatPrototypePatch(container: ChatContainerPrototype): void {
    const existingState = container[CHAT_TRANSITION_PATCH_STATE_KEY];
    if (existingState !== undefined) {
        existingState.enabled = true;
        return;
    }

    const originalAddChild = container.addChild;
    let nextState: ChatTransitionPatchState;
    const wrapperAddChild =
        typeof originalAddChild === "function"
            ? createChatTransitionSeparatorWrapper(originalAddChild, () => nextState.enabled)
            : undefined;
    if (wrapperAddChild !== undefined) {
        container.addChild = wrapperAddChild;
    }
    nextState = {
        enabled: true,
        originalAddChild,
        ...(wrapperAddChild === undefined ? {} : { wrapperAddChild }),
    };
    container[CHAT_TRANSITION_PATCH_STATE_KEY] = nextState;
    container[CHAT_TRANSITION_PATCH_KEY] = true;
}

function restoreAssistantSeparatorPatch(assistantPrototype: AssistantRenderPrototype): void {
    const state = assistantPrototype[ASSISTANT_SEPARATOR_PATCH_STATE_KEY];
    if (state === undefined) {
        return;
    }

    state.enabled = false;
    let restoredOwnWrappers = true;
    if (state.wrapperRender !== undefined) {
        if (assistantPrototype.render === state.wrapperRender) {
            restoreAssistantMethod(assistantPrototype, "render", state.originalRender);
        } else {
            restoredOwnWrappers = false;
        }
    }
    if (state.wrapperUpdateContent !== undefined) {
        if (assistantPrototype.updateContent === state.wrapperUpdateContent) {
            restoreAssistantMethod(
                assistantPrototype,
                "updateContent",
                state.originalUpdateContent,
            );
        } else {
            restoredOwnWrappers = false;
        }
    }

    if (restoredOwnWrappers) {
        delete assistantPrototype[ASSISTANT_SEPARATOR_PATCH_STATE_KEY];
        delete assistantPrototype[ASSISTANT_SEPARATOR_PATCH_KEY];
    }
}

function restoreChatTransitionPatch(container: ChatContainerPrototype): void {
    const state = container[CHAT_TRANSITION_PATCH_STATE_KEY];
    if (state === undefined) {
        return;
    }

    state.enabled = false;
    if (state.wrapperAddChild !== undefined) {
        if (container.addChild !== state.wrapperAddChild) {
            return;
        }
        if (state.originalAddChild === undefined) {
            delete container.addChild;
        } else {
            container.addChild = state.originalAddChild;
        }
    }
    delete container[CHAT_TRANSITION_PATCH_STATE_KEY];
    delete container[CHAT_TRANSITION_PATCH_KEY];
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
