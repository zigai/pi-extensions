import assert from "node:assert/strict";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";
import { test } from "vitest";

import { applySubmitModeKeymap } from "../src/submit-mode-patch.ts";

type PatchTarget = AgentSession | Editor;

function restoreProperty(
    target: PatchTarget,
    key: PropertyKey,
    descriptor: PropertyDescriptor,
): void {
    Object.defineProperty(target, key, descriptor);
}

function isPromptMethod(value: unknown): value is AgentSession["prompt"] {
    return typeof value === "function";
}

function isHandleInputMethod(value: unknown): value is Editor["handleInput"] {
    return typeof value === "function";
}

test("submit-mode patches transform input once and restore both predecessors", () => {
    const agentPrototype = AgentSession.prototype;
    const editorPrototype = Editor.prototype;
    const promptDescriptor = Object.getOwnPropertyDescriptor(agentPrototype, "prompt");
    const handleInputDescriptor = Object.getOwnPropertyDescriptor(editorPrototype, "handleInput");
    if (promptDescriptor === undefined || handleInputDescriptor === undefined) {
        assert.fail("Expected patchable Pi prompt and editor methods");
    }

    let receivedOptions: Parameters<AgentSession["prompt"]>[1];
    const receivedInput: string[] = [];
    const prompt: AgentSession["prompt"] = async function (this: AgentSession, _text, options) {
        assert.equal(this, agentPrototype);
        receivedOptions = options;
    };
    const handleInput: Editor["handleInput"] = function (this: Editor, data) {
        assert.equal(this, editorPrototype);
        receivedInput.push(data);
    };
    const previousTmux = process.env.TMUX;
    let handle: { dispose(): void } | undefined;
    try {
        process.env.TMUX = "test";
        Object.defineProperty(agentPrototype, "prompt", {
            ...promptDescriptor,
            value: prompt,
        });
        Object.defineProperty(editorPrototype, "handleInput", {
            ...handleInputDescriptor,
            value: handleInput,
        });

        handle = applySubmitModeKeymap();
        void agentPrototype.prompt("hello", { streamingBehavior: "steer" });
        editorPrototype.handleInput("\n");
        assert.deepEqual(receivedOptions, { streamingBehavior: "followUp" });
        assert.deepEqual(receivedInput, ["\r"]);
        assert.equal(applySubmitModeKeymap(), handle);
        handle.dispose();
        handle.dispose();
        const restoredPrompt: unknown = Object.getOwnPropertyDescriptor(
            agentPrototype,
            "prompt",
        )?.value;
        const restoredHandleInput: unknown = Object.getOwnPropertyDescriptor(
            editorPrototype,
            "handleInput",
        )?.value;
        if (!isPromptMethod(restoredPrompt) || !isHandleInputMethod(restoredHandleInput)) {
            assert.fail("Expected restored Pi methods");
        }

        assert.equal(restoredPrompt, prompt);
        assert.equal(restoredHandleInput, handleInput);
    } finally {
        handle?.dispose();
        restoreProperty(agentPrototype, "prompt", promptDescriptor);
        restoreProperty(editorPrototype, "handleInput", handleInputDescriptor);

        if (previousTmux === undefined) delete process.env.TMUX;
        else process.env.TMUX = previousTmux;
    }
});
