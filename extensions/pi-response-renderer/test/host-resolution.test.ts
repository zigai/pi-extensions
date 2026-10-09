import { expect, test } from "vitest";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import assistantRenderingExtension from "../src/index.ts";

test("patches the public assistant component and restores it on shutdown", async () => {
    const originalRender = AssistantMessageComponent.prototype.render;
    const originalUpdate = AssistantMessageComponent.prototype.updateContent;
    let shutdown: (() => void) | undefined;
    try {
        await assistantRenderingExtension({
            on(_event, handler) {
                shutdown = handler;
            },
        });
        expect(AssistantMessageComponent.prototype.render).not.toBe(originalRender);
        expect(AssistantMessageComponent.prototype.updateContent).not.toBe(originalUpdate);
    } finally {
        shutdown?.();
    }

    expect(AssistantMessageComponent.prototype.render).toBe(originalRender);
    expect(AssistantMessageComponent.prototype.updateContent).toBe(originalUpdate);
});
