import {
    AssistantMessageComponent,
    BashExecutionComponent,
    SkillInvocationMessageComponent,
    ToolExecutionComponent,
    UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, type Component, visibleWidth } from "@earendil-works/pi-tui";
import ansiStyles from "ansi-styles";

const ASSISTANT_SEPARATOR_PATCH_KEY = Symbol.for("zigai.pi-codex-look.assistant-separator");
const ASSISTANT_SEPARATOR_PATCH_STATE_KEY = Symbol.for(
    "zigai.pi-codex-look.assistant-separator.state",
);
const CHAT_TRANSITION_PATCH_KEY = Symbol.for("zigai.pi-codex-look.chat-transition-separator");
const CHAT_TRANSITION_PATCH_STATE_KEY = Symbol.for(
    "zigai.pi-codex-look.chat-transition-separator.state",
);
const ASSISTANT_SEPARATOR_RENDER_KEY = Symbol.for("zigai.pi-codex-look.assistant-separator.render");

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
    readonly originalRender: AssistantRenderPrototype["render"];
    readonly originalUpdateContent: AssistantRenderPrototype["updateContent"];
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
    readonly originalAddChild: ChatContainerPrototype["addChild"];
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

function hasNonWhitespaceText(text: string): boolean {
    for (let index = 0; index < text.length; index += 1) {
        const charCode = text.charCodeAt(index);
        if (
            charCode !== 9 &&
            charCode !== 10 &&
            charCode !== 11 &&
            charCode !== 12 &&
            charCode !== 13 &&
            charCode !== 32
        ) {
            return true;
        }
    }
    return false;
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

function installChatTransitionSeparatorPatch(
    prototype: ChatContainerPrototype,
    originalAddChild: (this: ChatContainerInstance, component: Component) => void,
): void {
    prototype.addChild = function addChildWithChatTransitionSeparator(
        this: ChatContainerInstance,
        component: Component,
    ): void {
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

function installThinkingBlockSpacingPatch(
    prototype: AssistantRenderPrototype,
    originalUpdateContent: (this: AssistantRenderInstance, message: AssistantMessageLike) => void,
): void {
    prototype.updateContent = function updateContentWithThinkingSpacing(
        this: AssistantRenderInstance,
        message: AssistantMessageLike,
    ): void {
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

export function installAssistantSeparatorPatch(
    prototype: object = assistantMessagePrototype,
    containerPrototype: object = chatContainerPrototype,
): void {
    configureAssistantSeparatorPatch(true, prototype, containerPrototype);
}

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
    if (assistantPrototype[ASSISTANT_SEPARATOR_PATCH_STATE_KEY] !== undefined) {
        return;
    }

    const originalRender = assistantPrototype.render;
    const originalUpdateContent = assistantPrototype.updateContent;
    if (typeof originalRender === "function") {
        assistantPrototype.render = function renderWithAssistantSeparator(
            this: AssistantRenderInstance,
            width: number,
        ): string[] {
            const lines = originalRender.call(this, width);
            if (lines.length === 0 || this[ASSISTANT_SEPARATOR_RENDER_KEY] !== true) {
                return lines;
            }
            return linesWithSeparatorSpacing(lines, width);
        };
    }

    if (typeof originalUpdateContent === "function") {
        installThinkingBlockSpacingPatch(assistantPrototype, originalUpdateContent);
    }

    assistantPrototype[ASSISTANT_SEPARATOR_PATCH_STATE_KEY] = {
        originalRender,
        originalUpdateContent,
    };
    assistantPrototype[ASSISTANT_SEPARATOR_PATCH_KEY] = true;
}

function installChatPrototypePatch(container: ChatContainerPrototype): void {
    if (container[CHAT_TRANSITION_PATCH_STATE_KEY] !== undefined) {
        return;
    }

    const originalAddChild = container.addChild;
    if (typeof originalAddChild === "function") {
        installChatTransitionSeparatorPatch(container, originalAddChild);
    }
    container[CHAT_TRANSITION_PATCH_STATE_KEY] = { originalAddChild };
    container[CHAT_TRANSITION_PATCH_KEY] = true;
}

function restoreAssistantSeparatorPatch(assistantPrototype: AssistantRenderPrototype): void {
    const state = assistantPrototype[ASSISTANT_SEPARATOR_PATCH_STATE_KEY];
    if (state === undefined) {
        return;
    }

    restoreAssistantMethod(assistantPrototype, "render", state.originalRender);
    restoreAssistantMethod(assistantPrototype, "updateContent", state.originalUpdateContent);
    delete assistantPrototype[ASSISTANT_SEPARATOR_PATCH_STATE_KEY];
    delete assistantPrototype[ASSISTANT_SEPARATOR_PATCH_KEY];
}

function restoreChatTransitionPatch(container: ChatContainerPrototype): void {
    const state = container[CHAT_TRANSITION_PATCH_STATE_KEY];
    if (state === undefined) {
        return;
    }

    if (state.originalAddChild === undefined) {
        delete container.addChild;
    } else {
        container.addChild = state.originalAddChild;
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
