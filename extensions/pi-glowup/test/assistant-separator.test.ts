import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { installAssistantSeparatorPatch } from "../src/assistant-separator.ts";

const ASSISTANT_SEPARATOR_RENDER_KEY = Symbol.for("zigai.pi-codex-look.assistant-separator.render");

type FakeAssistantContent = {
    readonly type: string;
    readonly text?: string;
    readonly thinking?: string;
};

type FakeAssistantMessage = {
    readonly content: ReadonlyArray<FakeAssistantContent>;
};

type FakeAssistantInstance = {
    readonly hasToolCalls?: boolean;
    readonly contentContainer?: {
        addChild(component: Component): void;
    };
    [ASSISTANT_SEPARATOR_RENDER_KEY]?: boolean;
};

type FakeAssistantPrototype = {
    render(this: FakeAssistantInstance, width: number): string[];
    updateContent?(this: FakeAssistantInstance, message: FakeAssistantMessage): void;
};

class LabelComponent implements Component {
    constructor(private readonly label: string) {}

    render(_width: number): string[] {
        return [this.label];
    }

    invalidate(): void {}
}

class RecordingContainer {
    readonly children: Component[] = [];

    addChild(component: Component): void {
        this.children.push(component);
    }
}

function createPrototype(lines: readonly string[] = ["assistant text"]): FakeAssistantPrototype {
    return {
        render(_width: number): string[] {
            return [...lines];
        },
    };
}

function isVisibleContent(content: FakeAssistantContent): boolean {
    if (content.type === "text" && typeof content.text === "string") {
        return content.text.trim() !== "";
    }
    if (content.type === "thinking" && typeof content.thinking === "string") {
        return content.thinking.trim() !== "";
    }
    return false;
}

function createPrototypeWithContentUpdates(): FakeAssistantPrototype {
    return {
        render(_width: number): string[] {
            return [];
        },
        updateContent(message: FakeAssistantMessage): void {
            if (message.content.some(isVisibleContent)) {
                this.contentContainer?.addChild(new LabelComponent("initial-spacer"));
            }

            for (const [index, content] of message.content.entries()) {
                if (
                    content.type === "text" &&
                    typeof content.text === "string" &&
                    content.text.trim() !== ""
                ) {
                    this.contentContainer?.addChild(new LabelComponent(`text:${content.text}`));
                    continue;
                }

                if (
                    content.type === "thinking" &&
                    typeof content.thinking === "string" &&
                    content.thinking.trim() !== ""
                ) {
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

function renderedChildren(container: RecordingContainer): string[] {
    return container.children.flatMap((child) => child.render(20));
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

    it("adds a blank line before thinking that follows assistant text", () => {
        const prototype = createPrototypeWithContentUpdates();
        const contentContainer = new RecordingContainer();
        installAssistantSeparatorPatch(prototype);

        prototype.updateContent?.call(
            { contentContainer },
            {
                content: [
                    { type: "text", text: "normal update" },
                    { type: "thinking", thinking: "Considering probe implementation" },
                ],
            },
        );

        expect(renderedChildren(contentContainer)).toEqual([
            "initial-spacer",
            "text:normal update",
            "",
            "thinking:Considering probe implementation",
        ]);
    });

    it("keeps Pi's existing spacer after thinking before assistant text", () => {
        const prototype = createPrototypeWithContentUpdates();
        const contentContainer = new RecordingContainer();
        installAssistantSeparatorPatch(prototype);

        prototype.updateContent?.call(
            { contentContainer },
            {
                content: [
                    { type: "thinking", thinking: "Considering probe implementation" },
                    { type: "text", text: "normal update" },
                ],
            },
        );

        expect(renderedChildren(contentContainer)).toEqual([
            "initial-spacer",
            "thinking:Considering probe implementation",
            "after-thinking-spacer",
            "text:normal update",
        ]);
    });

    it("is idempotent for a patched prototype", () => {
        const prototype = createPrototype();

        installAssistantSeparatorPatch(prototype);
        const patchedRender = Reflect.get(prototype, "render");
        installAssistantSeparatorPatch(prototype);

        expect(Reflect.get(prototype, "render")).toBe(patchedRender);
    });
});
