import type * as EditorProtocolModule from "../src/editor-enhancer-registry.ts";
import type * as PatchProtocolModule from "../src/linked-method-patch.ts";
import type * as TranscriptProtocolModule from "../src/transcript-presentation.ts";

import { expect, test } from "vitest";

type EditorProtocol = Pick<typeof EditorProtocolModule, "registerEditorEnhancer">;
type PatchProtocol = Pick<
    typeof PatchProtocolModule,
    "installLinkedRenderPatch" | "installKeyedLinkedMethodPatch"
>;

function isEditorProtocol(value: unknown): value is EditorProtocol {
    return (
        typeof value === "object" &&
        value !== null &&
        "registerEditorEnhancer" in value &&
        typeof value.registerEditorEnhancer === "function"
    );
}

function isPatchProtocol(value: unknown): value is PatchProtocol {
    return (
        typeof value === "object" &&
        value !== null &&
        "installLinkedRenderPatch" in value &&
        typeof value.installLinkedRenderPatch === "function" &&
        "installKeyedLinkedMethodPatch" in value &&
        typeof value.installKeyedLinkedMethodPatch === "function"
    );
}

// Query-distinct URLs load independent copies of these exact, compiler-checked source modules.
// Validate the consumed exports before exercising their composition contracts.
async function loadEditorProtocolCopy(copy: string): Promise<EditorProtocol> {
    const moduleUrl = new URL(`../src/editor-enhancer-registry.ts?copy=${copy}`, import.meta.url)
        .href;
    const imported: unknown = await import(moduleUrl);
    if (!isEditorProtocol(imported)) throw new Error("Invalid editor protocol module");
    return imported;
}

async function loadPatchProtocolCopy(copy: string): Promise<PatchProtocol> {
    const moduleUrl = new URL(`../src/linked-method-patch.ts?copy=${copy}`, import.meta.url).href;
    const imported: unknown = await import(moduleUrl);
    if (!isPatchProtocol(imported)) throw new Error("Invalid linked-patch protocol module");
    return imported;
}

type TranscriptProtocol = typeof TranscriptProtocolModule;

function isTranscriptProtocol(value: unknown): value is TranscriptProtocol {
    return (
        typeof value === "object" &&
        value !== null &&
        "TRANSCRIPT_PRESENTATION" in value &&
        typeof value.TRANSCRIPT_PRESENTATION === "symbol" &&
        "prepareTranscriptPresentation" in value &&
        typeof value.prepareTranscriptPresentation === "function"
    );
}

async function loadTranscriptProtocolCopy(copy: string): Promise<TranscriptProtocol> {
    const url = new URL(`../src/transcript-presentation.ts?copy=${copy}`, import.meta.url).href;
    const imported: unknown = await import(url);
    if (!isTranscriptProtocol(imported)) throw new Error("Invalid transcript protocol module");
    return imported;
}

test("separate transcript consumers prepare original rows without rendering the source", async () => {
    const provider = await loadTranscriptProtocolCopy("provider");
    const consumer = await loadTranscriptProtocolCopy("consumer");
    const source = {
        children: [{ text: "original content" }],
        render(): never {
            throw new Error("Hidden source rendering is forbidden");
        },
    };
    consumer.prepareTranscriptPresentation(source);
    expect(source.children).toEqual([{ text: "original content" }]);
    const originalRows = source.children;
    Reflect.set(source, provider.TRANSCRIPT_PRESENTATION, function (this: typeof source): void {
        for (const row of this.children) row.text = `presented ${row.text}`;
    });

    consumer.prepareTranscriptPresentation(source);
    expect(source.children).toBe(originalRows);
    expect(source.children).toEqual([{ text: "presented original content" }]);
    Reflect.set(source, provider.TRANSCRIPT_PRESENTATION, "invalid");
    expect(() => consumer.prepareTranscriptPresentation(source)).toThrow(TypeError);
});

class EditorUi {
    private factory: ((label: string) => string[]) | undefined = () => ["base"];

    getEditorComponent(): ((label: string) => string[]) | undefined {
        return this.factory;
    }

    setEditorComponent(factory: ((label: string) => string[]) | undefined): void {
        this.factory = factory;
    }

    render(): string[] {
        if (this.factory === undefined) throw new Error("Expected an editor factory");
        return this.factory("prompt");
    }
}

class Renderer {
    render(width: number): string[] {
        return [`base:${width}`];
    }
}

test("independently loaded editor protocol copies share registrations and disposal", async () => {
    const first = await loadEditorProtocolCopy("a");
    const second = await loadEditorProtocolCopy("b");
    expect(first.registerEditorEnhancer).not.toBe(second.registerEditorEnhancer);

    const ui = new EditorUi();
    const context = { hasUI: true, ui };
    const firstHandle = first.registerEditorEnhancer(
        context,
        Symbol.for("zigai.pi-extension-internals.test.copy-first"),
        () => ["fallback-a"],
        (editor) => [...editor, "first"],
    );
    const secondHandle = second.registerEditorEnhancer(
        context,
        Symbol.for("zigai.pi-extension-internals.test.copy-second"),
        () => ["fallback-b"],
        (editor) => [...editor, "second"],
    );

    expect(ui.render()).toEqual(["base", "first", "second"]);
    firstHandle.dispose();
    expect(ui.render()).toEqual(["base", "second"]);
    secondHandle.dispose();
    expect(ui.render()).toEqual(["base"]);
});

test("independently loaded linked patch copies compose and rewire each other", async () => {
    const first = await loadPatchProtocolCopy("a");
    const second = await loadPatchProtocolCopy("b");
    expect(first.installLinkedRenderPatch).not.toBe(second.installLinkedRenderPatch);

    const lower = first.installLinkedRenderPatch(
        Renderer.prototype,
        (predecessor) =>
            function (this: Renderer, width: number): string[] {
                return [...predecessor.call(this, width), "lower"];
            },
    );
    const upper = second.installLinkedRenderPatch(
        Renderer.prototype,
        (predecessor) =>
            function (this: Renderer, width: number): string[] {
                return [...predecessor.call(this, width), "upper"];
            },
    );

    expect(new Renderer().render(7)).toEqual(["base:7", "lower", "upper"]);
    lower.dispose();
    expect(new Renderer().render(7)).toEqual(["base:7", "upper"]);
    upper.dispose();
    expect(new Renderer().render(7)).toEqual(["base:7"]);
});

test("independently loaded keyed patch copies update one shared registration", async () => {
    const first = await loadPatchProtocolCopy("keyed-a");
    const second = await loadPatchProtocolCopy("keyed-b");
    const marker = Symbol.for("zigai.pi-extension-internals.test.copy-keyed");
    const firstHandle = first.installKeyedLinkedMethodPatch(
        Renderer.prototype,
        "render",
        marker,
        "first",
        (predecessor, getLabel) =>
            function (this: Renderer, width: number): string[] {
                return [...predecessor.call(this, width), getLabel()];
            },
    );
    const secondHandle = second.installKeyedLinkedMethodPatch(
        Renderer.prototype,
        "render",
        marker,
        "updated",
        () => {
            throw new Error("A compatible copy must reuse the keyed patch");
        },
    );

    expect(secondHandle).toBe(firstHandle);
    expect(new Renderer().render(2)).toEqual(["base:2", "updated"]);
    secondHandle.dispose();
    expect(new Renderer().render(2)).toEqual(["base:2"]);
});
