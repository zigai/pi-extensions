import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Component, MarkdownTheme } from "@earendil-works/pi-tui";

type AssistantContentContainer = {
    addChild: (this: AssistantContentContainer, component: Component) => void;
};

export type AssistantMessageComponentInstance = AssistantMessageComponentPrototype & {
    contentContainer?: AssistantContentContainer;
};

export type AssistantMessageComponentPrototype = {
    render: (this: AssistantMessageComponentInstance, width: number) => string[];

    updateContent: (
        this: AssistantMessageComponentInstance,
        message: AssistantMessage,
        isStreaming?: boolean,
    ) => void;
};

type AssistantMessageComponentConstructor = {
    new (
        message?: AssistantMessage,
        hideThinkingBlock?: boolean,
        theme?: MarkdownTheme,
        hiddenThinkingLabel?: string,
        outputPad?: number,
    ): AssistantMessageComponentInstance;

    readonly prototype: AssistantMessageComponentPrototype;
};

function isObjectIdentity(value: unknown): value is object {
    return (typeof value === "object" && value !== null) || typeof value === "function";
}

/**
 * Checks the private assistant export from a resolved Pi runtime module.
 * Shape incompatibility returns undefined; callable signatures rely on Pi's runtime contract,
 * not on reflection proving arbitrary executable code safe.
 */
export const assistantMessageRuntime = {
    parse: (module: unknown): AssistantMessageComponentConstructor | undefined => {
        if (!isObjectIdentity(module) || !("AssistantMessageComponent" in module)) {
            return undefined;
        }

        const component = module.AssistantMessageComponent;
        if (typeof component !== "function" || !("prototype" in component)) return undefined;

        const prototype: unknown = component.prototype;
        if (
            !isObjectIdentity(prototype) ||
            !("render" in prototype) ||
            typeof prototype.render !== "function" ||
            !("updateContent" in prototype) ||
            typeof prototype.updateContent !== "function"
        ) {
            return undefined;
        }

        try {
            // Check [[Construct]] without executing Pi's constructor (or rendering a message).
            Reflect.construct(Object, [], component);
        } catch {
            return undefined;
        }
        // Contract tests exercise the installed implementation and reject malformed exports.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Constructability and both lifecycle methods are checked above; Pi's private assistant-message contract establishes call signatures and instance state, which runtime reflection cannot prove.
        return component as AssistantMessageComponentConstructor;
    },
};
