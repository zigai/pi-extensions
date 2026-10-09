import { expect, test } from "vitest";
import { installLinkedRenderPatch } from "@zigai/pi-extension-internals";
import { installMessageHighlightPatch } from "../src/message-highlight-patch.ts";
import { DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG } from "../src/settings.ts";

test("rendering reads the current theme after theme changes", () => {
    const assistantPrototype = { render: (_width: number) => ["https://example.com"] };
    const userPrototype = { render: (_width: number) => [] };
    const editorPrototype = { render: (_width: number) => [] };
    const original = assistantPrototype.render;
    let color = "31";
    const patch = installMessageHighlightPatch(
        { assistantPrototype, userPrototype, editorPrototype },
        { urlColor: { kind: "theme", color: "mdLink" } },
        () => ({
            fg: (_name, text) => `\u001b[${color}m${text}\u001b[39m`,
            getColorMode: () => "truecolor",
        }),
    );
    try {
        expect(assistantPrototype.render(80).join(" ")).toContain("\u001b[31m");
        color = "34";
        expect(assistantPrototype.render(80).join(" ")).toContain("\u001b[34m");
    } finally {
        patch.dispose();
    }

    expect(assistantPrototype.render).toBe(original);
});

test("reinstall updates current policy without stacking; disposal preserves successor", () => {
    const assistantPrototype = { render: (_width: number) => ["https://example.com"] };
    const userPrototype = { render: (_width: number) => ["https://example.com"] };
    const editorPrototype = { render: (_width: number) => [], getText: () => "" };
    const original = assistantPrototype.render;
    const targets = { assistantPrototype, userPrototype, editorPrototype };
    const patch = installMessageHighlightPatch(
        targets,
        DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
        () => undefined,
    );
    const installed = assistantPrototype.render;
    const same = installMessageHighlightPatch(
        targets,
        { urlColor: { kind: "none" } },
        () => undefined,
    );
    expect(same).toBe(patch);
    expect(assistantPrototype.render).toBe(installed);
    expect(assistantPrototype.render(80).join("\n")).not.toContain("38;");
    patch.update(DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG);
    expect(assistantPrototype.render(80).join("\n")).toContain("38;");
    const successor = installLinkedRenderPatch(
        assistantPrototype,
        (previous) =>
            function (width) {
                return [...previous.call(this, width), "successor"];
            },
    );
    patch.dispose();
    patch.dispose();
    patch.update(DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG);
    expect(assistantPrototype.render(80)).toEqual(["https://example.com", "successor"]);
    successor.dispose();
    expect(assistantPrototype.render).toBe(original);
});
