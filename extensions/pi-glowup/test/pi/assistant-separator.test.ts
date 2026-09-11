import { stripVTControlCharacters } from "node:util";
import { initTheme, AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { configureAssistantSeparatorPatch } from "../../src/pi/patches/assistant-separator.ts";

const ASSISTANT_SEPARATOR_RENDER_KEY = Symbol.for("zigai.pi-glowup.assistant-separator.render");

type FakeAssistantContent = AssistantMessage["content"][number];

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
    return {
        role: "assistant",
        content,
        api: "anthropic",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
    };
}

type FakeAssistantInstance = {
    readonly hasToolCalls?: boolean;
    readonly contentContainer?: Container;
    [ASSISTANT_SEPARATOR_RENDER_KEY]?: boolean;
};

type FakeAssistantPrototype = {
    render(this: FakeAssistantInstance, width: number): string[];

    updateContent?(
        this: FakeAssistantInstance,
        message: AssistantMessage,
        isStreaming?: boolean,
    ): void;
};

type FakeContainerPrototype = {
    addChild(component: Component): void;
};

function installAssistantSeparatorPatch(prototype: FakeAssistantPrototype): void {
    configureAssistantSeparatorPatch(true, prototype);
}

class LabelComponent implements Component {
    constructor(private readonly label: string) {}

    render(_width: number): string[] {
        return [this.label];
    }

    invalidate(): void {}
}

function createPrototype(lines: readonly string[] = ["assistant text"]): FakeAssistantPrototype {
    return {
        render(_width: number): string[] {
            return [...lines];
        },
    };
}

function isVisibleContent(content: FakeAssistantContent): boolean {
    if (content.type === "text") {
        return content.text.trim() !== "";
    }

    if (content.type === "thinking") {
        return content.thinking.trim() !== "";
    }

    return false;
}

function createPrototypeWithContentUpdates(): FakeAssistantPrototype {
    return {
        render(_width: number): string[] {
            return [];
        },
        updateContent(message: AssistantMessage): void {
            if (message.content.some(isVisibleContent)) {
                this.contentContainer?.addChild(new LabelComponent("initial-spacer"));
            }

            for (const [index, content] of message.content.entries()) {
                if (content.type === "text" && content.text.trim() !== "") {
                    this.contentContainer?.addChild(new LabelComponent(`text:${content.text}`));

                    continue;
                }

                if (content.type === "thinking" && content.thinking.trim() !== "") {
                    this.contentContainer?.addChild(
                        new LabelComponent(`thinking:${content.thinking}`),
                    );

                    if (message.content.slice(index + 1).some(isVisibleContent)) {
                        this.contentContainer?.addChild(
                            new LabelComponent("after-thinking-spacer"),
                        );
                    }
                }
            }
        },
    };
}

describe("assistant separator patch", () => {
    it("does not add a separator before an ordinary assistant reply", () => {
        const prototype = createPrototype();
        installAssistantSeparatorPatch(prototype);

        expect(prototype.render.call({}, 6)).toEqual(["assistant text"]);
    });

    it("surrounds the separator with blank lines when marked after a tool", () => {
        const prototype = createPrototype();
        installAssistantSeparatorPatch(prototype);

        expect(prototype.render.call({ [ASSISTANT_SEPARATOR_RENDER_KEY]: true }, 6)).toEqual([
            "",
            "\u001b[2m──────\u001b[0m",
            "",
            "assistant text",
        ]);
    });

    it("reuses Pi's existing leading blank line below a marked separator", () => {
        const prototype = createPrototype(["", "assistant text"]);
        installAssistantSeparatorPatch(prototype);

        expect(prototype.render.call({ [ASSISTANT_SEPARATOR_RENDER_KEY]: true }, 6)).toEqual([
            "",
            "\u001b[2m──────\u001b[0m",
            "",
            "assistant text",
        ]);
    });

    it("keeps the separator within the current render width when content is wider", () => {
        const prototype = createPrototype(["short", "assistant content that exceeds local width"]);
        installAssistantSeparatorPatch(prototype);

        expect(prototype.render.call({ [ASSISTANT_SEPARATOR_RENDER_KEY]: true }, 6)[1]).toBe(
            "\u001b[2m──────\u001b[0m",
        );
    });

    it("adds a blank line before thinking that follows assistant text with real AssistantMessageComponent", () => {
        initTheme("dark");
        configureAssistantSeparatorPatch(true);
        try {
            const component = new AssistantMessageComponent({
                role: "assistant",
                content: [
                    { type: "text", text: "normal update" },
                    { type: "thinking", thinking: "Considering probe implementation" },
                ],
                api: "anthropic",
                provider: "anthropic",
                model: "claude-3-5-sonnet",
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: Date.now(),
            });
            const lines = component.render(80);
            expect(lines.length).toBeGreaterThan(0);
            const textIndex = lines.findIndex((line) => line.includes("normal update"));
            const thinkingIndex = lines.findIndex((line) =>
                line.includes("Considering probe implementation"),
            );
            expect(textIndex).toBeGreaterThan(-1);
            expect(thinkingIndex).toBe(textIndex + 2);
            expect(stripVTControlCharacters(lines[textIndex + 1] ?? "missing").trim()).toBe("");
        } finally {
            configureAssistantSeparatorPatch(false);
        }
    });

    it("handles consecutive thinking blocks and text-to-thinking transitions in real AssistantMessageComponent", () => {
        initTheme("dark");
        configureAssistantSeparatorPatch(true);
        try {
            const component = new AssistantMessageComponent({
                role: "assistant",
                content: [
                    { type: "text", text: "text A" },
                    { type: "thinking", thinking: "thinking X" },
                    { type: "thinking", thinking: "" },
                    { type: "thinking", thinking: "thinking Y" },
                    { type: "text", text: "text B" },
                    { type: "thinking", thinking: "thinking Z" },
                ],
                api: "anthropic",
                provider: "anthropic",
                model: "claude-3-5-sonnet",
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: Date.now(),
            });

            const expected = [
                "",
                "text A",
                "",
                "thinking X",
                "",
                "thinking Y",
                "",
                "text B",
                "",
                "thinking Z",
            ];
            expect(
                component.render(80).map((line) => stripVTControlCharacters(line).trim()),
            ).toEqual(expected);

            component.invalidate();
            expect(
                component.render(80).map((line) => stripVTControlCharacters(line).trim()),
            ).toEqual(expected);

            component.setHideThinkingBlock(true);
            expect(
                component.render(80).map((line) => stripVTControlCharacters(line).trim()),
            ).toEqual(["", "text A", "", "Thinking...", "", "text B", "", "Thinking..."]);

            component.setHideThinkingBlock(false);
            expect(
                component.render(80).map((line) => stripVTControlCharacters(line).trim()),
            ).toEqual(expected);
        } finally {
            configureAssistantSeparatorPatch(false);
        }
    });

    it("forwards streaming state through active, containerless and disabled wrappers", () => {
        const received: Array<boolean | undefined> = [];
        const prototype: FakeAssistantPrototype = {
            render: () => [],
            updateContent(_message, isStreaming) {
                received.push(isStreaming);
            },
        };
        installAssistantSeparatorPatch(prototype);
        const instance = { contentContainer: new Container() };
        const message = assistantMessage([]);
        prototype.updateContent?.call(instance, message, true);
        prototype.updateContent?.call({}, message, false);

        // Retain the wrapper to exercise another extension's captured delegation after disable.
        const wrapped = prototype.updateContent?.bind(instance);
        configureAssistantSeparatorPatch(false, prototype);
        wrapped?.(message, true);
        expect(received).toEqual([true, false, true]);
    });

    it("delegates unchanged when the private content container is incompatible", () => {
        const instance = {
            contentContainer: {
                addChild() {
                    throw new Error("not a Container");
                },
            },
        };
        const received: Array<typeof instance> = [];
        const prototype = {
            updateContent(this: typeof instance, _message: AssistantMessage): void {
                received.push(this);
            },
        };
        configureAssistantSeparatorPatch(true, prototype);
        try {
            prototype.updateContent.call(instance, assistantMessage([]));
            expect(received).toEqual([instance]);
            expect(received[0]).toBe(instance);
        } finally {
            configureAssistantSeparatorPatch(false, prototype);
        }
    });

    it("restores the exact content-container method when an update fails", () => {
        const contentContainer = new Container();
        const failure = new Error("update failed");
        const instance = { contentContainer };
        const prototype = {
            updateContent(this: typeof instance, _message: AssistantMessage): void {
                expect(this).toBe(instance);
                this.contentContainer.addChild(new LabelComponent("before failure"));

                throw failure;
            },
        };
        configureAssistantSeparatorPatch(true, prototype);
        const originalDescriptor = Object.getOwnPropertyDescriptor(Container.prototype, "addChild");
        try {
            expect(() => prototype.updateContent.call(instance, assistantMessage([]))).toThrow(
                failure,
            );

            expect(Object.getOwnPropertyDescriptor(contentContainer, "addChild")?.value).toBe(
                originalDescriptor?.value,
            );

            expect(contentContainer.render(20)).toEqual(["before failure"]);
        } finally {
            configureAssistantSeparatorPatch(false, prototype);
        }
    });

    it("is idempotent for a patched prototype", () => {
        const prototype = createPrototype();

        installAssistantSeparatorPatch(prototype);
        const patchedRenderDescriptor = Object.getOwnPropertyDescriptor(prototype, "render");
        installAssistantSeparatorPatch(prototype);

        expect(Object.getOwnPropertyDescriptor(prototype, "render")).toEqual(
            patchedRenderDescriptor,
        );
    });

    it("restores original assistant and chat container methods when disabled", () => {
        const prototype = createPrototypeWithContentUpdates();
        const containerPrototype: FakeContainerPrototype = {
            addChild(_component: Component): void {},
        };
        const originalRenderDescriptor = Object.getOwnPropertyDescriptor(prototype, "render");
        const originalUpdateDescriptor = Object.getOwnPropertyDescriptor(
            prototype,
            "updateContent",
        );
        const originalAddChildDescriptor = Object.getOwnPropertyDescriptor(
            containerPrototype,
            "addChild",
        );

        configureAssistantSeparatorPatch(true, prototype, containerPrototype);
        configureAssistantSeparatorPatch(false, prototype, containerPrototype);

        expect(Object.getOwnPropertyDescriptor(prototype, "render")).toEqual(
            originalRenderDescriptor,
        );

        expect(Object.getOwnPropertyDescriptor(prototype, "updateContent")).toEqual(
            originalUpdateDescriptor,
        );

        expect(Object.getOwnPropertyDescriptor(containerPrototype, "addChild")).toEqual(
            originalAddChildDescriptor,
        );
    });

    it("does not clobber assistant and chat wrappers installed later", () => {
        const prototype = createPrototypeWithContentUpdates();
        const addedChildren: Component[] = [];
        const containerPrototype: FakeContainerPrototype = {
            addChild(component: Component): void {
                addedChildren.push(component);
            },
        };
        configureAssistantSeparatorPatch(true, prototype, containerPrototype);
        const patchedPrototype: FakeAssistantPrototype = { ...prototype };
        const patchedContainerPrototype: FakeContainerPrototype = { ...containerPrototype };
        const patchedRenderDescriptor = Object.getOwnPropertyDescriptor(prototype, "render");
        const patchedAddChildDescriptor = Object.getOwnPropertyDescriptor(
            containerPrototype,
            "addChild",
        );
        if (patchedRenderDescriptor === undefined || patchedAddChildDescriptor === undefined) {
            throw new Error("expected Glowup assistant wrappers");
        }

        Object.defineProperty(patchedPrototype, "render", patchedRenderDescriptor);
        Object.defineProperty(patchedContainerPrototype, "addChild", patchedAddChildDescriptor);
        prototype.render = function renderWithLaterWrapper(
            this: FakeAssistantInstance,
            width: number,
        ): string[] {
            return patchedPrototype.render.call(this, width);
        };
        containerPrototype.addChild = function addChildWithLaterWrapper(
            this: FakeContainerPrototype,
            component: Component,
        ): void {
            patchedContainerPrototype.addChild.call(this, component);
        };
        const laterRenderDescriptor = Object.getOwnPropertyDescriptor(prototype, "render");
        const laterAddChildDescriptor = Object.getOwnPropertyDescriptor(
            containerPrototype,
            "addChild",
        );

        configureAssistantSeparatorPatch(false, prototype, containerPrototype);

        expect(Object.getOwnPropertyDescriptor(prototype, "render")).toEqual(laterRenderDescriptor);
        expect(Object.getOwnPropertyDescriptor(containerPrototype, "addChild")).toEqual(
            laterAddChildDescriptor,
        );

        expect(prototype.render.call({ [ASSISTANT_SEPARATOR_RENDER_KEY]: true }, 6)).toEqual([]);
        containerPrototype.addChild(new LabelComponent("child"));
        expect(addedChildren.flatMap((child) => child.render(20))).toEqual(["child"]);

        configureAssistantSeparatorPatch(true, prototype, containerPrototype);
        const contentContainer = new Container();
        prototype.updateContent?.call(
            { contentContainer },
            assistantMessage([
                { type: "text", text: "first" },
                { type: "thinking", thinking: "next" },
            ]),
        );

        expect(contentContainer.render(20)).toEqual([
            "initial-spacer",
            "text:first",
            "",
            "thinking:next",
        ]);

        expect(Object.getOwnPropertyDescriptor(prototype, "render")).toEqual(laterRenderDescriptor);
        configureAssistantSeparatorPatch(false, prototype, containerPrototype);
    });
});
