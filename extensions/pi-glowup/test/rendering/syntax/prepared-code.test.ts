import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
    cachedSyntaxCode,
    disposeSyntaxHighlighting,
    initializeSyntaxHighlighting,
    highlightSyntaxCodeAsync,
    inheritReadySyntaxHighlights,
    retireSyntaxHighlightSource,
    getLoadedSyntaxHighlighterForLanguage,
    observeSyntaxHighlightSource,
    prepareSyntaxCode,
} from "../../../src/rendering/syntax/highlighter.ts";

const code = Array.from(
    { length: 250 },
    (_value, index) => `const prepared${index} = formatValue("prepared_${index}", ${index});`,
).join("\n");

afterEach(async () => disposeSyntaxHighlighting());

it("adopts prepared large code into its actual component owner without a global strong cache", async () => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
    expect(Buffer.byteLength(code)).toBeGreaterThan(8 * 1024);
    const prepared = await prepareSyntaxCode(code, "typescript", undefined);
    expect(prepared).toBeDefined();
    const invalidate = () => {};
    observeSyntaxHighlightSource(code, invalidate);
    prepared?.adopt(invalidate);
    const lines = cachedSyntaxCode(code, "typescript", { invalidate, cache: false });
    expect(lines?.[0]).toContain("\u001b[38;2;86;156;214mconst");
});

it("does not adopt a prepared result after syntax generation reset", async () => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
    const prepared = await prepareSyntaxCode(code, "typescript", undefined);
    expect(prepared).toBeDefined();
    await disposeSyntaxHighlighting();
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
    const invalidate = () => {};
    observeSyntaxHighlightSource(code, invalidate);
    prepared?.adopt(invalidate);
    expect(cachedSyntaxCode(code, "typescript", { invalidate, cache: false })).toBeUndefined();
});

it("does not prepare aborted or disabled syntax work", async () => {
    const controller = new AbortController();
    controller.abort();
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
    expect(await prepareSyntaxCode(code, "typescript", controller.signal)).toBeUndefined();
    await disposeSyntaxHighlighting();
    await initializeSyntaxHighlighting({ PI_GLOWUP_SYNTAX: "off" });
    expect(await prepareSyntaxCode(code, "typescript", undefined)).toBeUndefined();
});

it("keeps formatting best-effort when a dynamic syntax grammar fails to load", async () => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
    const loaded = getLoadedSyntaxHighlighterForLanguage("typescript");
    if (loaded === undefined) throw new Error("Expected initialized syntax highlighter");

    const failure = vi
        .spyOn(loaded.highlighter, "loadLanguage")
        .mockRejectedValue(new Error("fixture grammar failure"));
    onTestFinished(() => failure.mockRestore());
    await expect(prepareSyntaxCode("puts 42", "ruby", undefined)).resolves.toBeUndefined();
});

it("releases an aborted preparation without waiting for an unrelated grammar load", async () => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
    const loaded = getLoadedSyntaxHighlighterForLanguage("typescript");
    if (loaded === undefined) throw new Error("Expected initialized syntax highlighter");

    let release = () => {};
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const loading = vi.spyOn(loaded.highlighter, "loadLanguage").mockReturnValue(gate);
    onTestFinished(() => {
        release();
        loading.mockRestore();
    });
    const controller = new AbortController();
    const pending = prepareSyntaxCode("puts 42", "ruby", controller.signal);
    let completed = false;
    void pending.then(() => {
        completed = true;
    });

    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completed).toBe(true);
    expect(await pending).toBeUndefined();
    release();
});

it("forks exact-source ready values without coupling owner retirement", async () => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
    const ready = await prepareSyntaxCode(code, "typescript", undefined);
    const source = () => {};
    const target = () => {};
    observeSyntaxHighlightSource(code, source);
    ready?.adopt(source);
    observeSyntaxHighlightSource(code, target);
    inheritReadySyntaxHighlights(target, source);
    expect(
        cachedSyntaxCode(code, "typescript", { invalidate: target, cache: false })?.[0],
    ).toContain("\u001b[38;2;86;156;214mconst");

    retireSyntaxHighlightSource(target);
    expect(
        cachedSyntaxCode(code, "typescript", { invalidate: source, cache: false }),
    ).toBeDefined();

    observeSyntaxHighlightSource(`${code}\n// different source`, target);
    inheritReadySyntaxHighlights(target, source);
    expect(
        cachedSyntaxCode(code, "typescript", { invalidate: target, cache: false }),
    ).toBeUndefined();

    observeSyntaxHighlightSource(code, target);
    inheritReadySyntaxHighlights(target, source);
    retireSyntaxHighlightSource(source);
    expect(
        cachedSyntaxCode(code, "typescript", { invalidate: target, cache: false }),
    ).toBeDefined();
});

it("does not transfer pending work into an independent layout owner", async () => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
    const source = () => {};
    const target = () => {};
    observeSyntaxHighlightSource(code, source);
    const pending = highlightSyntaxCodeAsync(code, "typescript", {
        invalidate: source,
        cache: false,
    });
    observeSyntaxHighlightSource(code, target);
    inheritReadySyntaxHighlights(target, source);
    expect(
        cachedSyntaxCode(code, "typescript", { invalidate: target, cache: false }),
    ).toBeUndefined();
    await pending;
    expect(
        cachedSyntaxCode(code, "typescript", { invalidate: target, cache: false }),
    ).toBeUndefined();

    inheritReadySyntaxHighlights(target, source);
    expect(
        cachedSyntaxCode(code, "typescript", { invalidate: target, cache: false }),
    ).toBeDefined();
});
