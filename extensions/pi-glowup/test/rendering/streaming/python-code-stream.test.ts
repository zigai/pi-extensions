import { bindExtensionDiagnostics } from "@zigai/pi-extension-internals";
import { afterEach, expect, it } from "vitest";
import {
    createCodeStreamStore,
    type CodeStreamStore,
} from "../../../src/rendering/streaming/code-stream.ts";
import { createStatementService } from "../../../src/rendering/streaming/statement-service.ts";

const stores: CodeStreamStore[] = [];
afterEach(async () => {
    await Promise.all(stores.splice(0).map(async (store) => store.dispose()));
});

it.each([
    "try:\n x=1\nexcept ValueError:\n x=2\n",
    "try:\n x=1\nfinally:\n x=2\n",
    "try:\n x=1\nexcept* Exception:\n x=2\n",
    "def read():\n try:\n  x=1\n except ValueError:\n  x=2\n",
])("supplies valid independent Python formatter units for %s", async (source) => {
    const store = createCodeStreamStore();
    stores.push(store);
    const parser = createStatementService();
    const invalidInputs: string[] = [];
    const inputs: string[] = [];
    const formatter = async ({ code }: { code: string }) => {
        inputs.push(code);
        const parsed = await parser.parse(code, "python", true, new AbortController().signal);
        if (parsed === undefined || "error" in parsed) throw new Error("Parser unavailable");

        if (parsed.malformed) {
            invalidInputs.push(code);
            return undefined;
        }

        return code;
    };
    const input = {
        key: "python-try",
        source,
        language: "python",
        mode: "statement" as const,
        complete: true,
        formatter,
    };
    try {
        store.get(input);
        await store.settled();
        expect(invalidInputs).toEqual([]);
        const tryHeader = inputs.find((code) => /begin\ntry:/u.test(code));
        expect(tryHeader).toMatch(/\nfinally:\n    pass\n$/u);
        const display = store.get(input);
        expect(display).not.toContain("__glowup_");
        expect(display).not.toContain("pass");
        expect(display).toContain("    x=1");
        expect(store.ready(input.key)).toBe(true);
    } finally {
        await parser.dispose();
    }
});

it.each(['"""hello\nworld\n"""', "r'''hello\n  world\n'''", 'f"""hello {1}\nworld\n"""'])(
    "preserves multiline Python literal contents during independent indentation: %s",
    async (literal) => {
        const store = createCodeStreamStore();
        stores.push(store);
        const inputs: string[] = [];
        const input = {
            key: "python-literal",
            source: `def read():\n text=${literal}\n return text\n`,
            language: "python",
            mode: "statement" as const,
            complete: true,
            formatter: async ({ code }: { code: string }) => {
                inputs.push(code);
                return code;
            },
        };
        store.get(input);
        await store.settled();
        expect(store.get(input)).toBe(`def read():\n    text=${literal}\n    return text\n`);
        expect(inputs.every((code) => !code.includes("hello"))).toBe(true);
    },
);

it("preserves multiline default values in nested Python headers while reindenting their bodies", async () => {
    const store = createCodeStreamStore();
    stores.push(store);
    const literal = '"""first\n original literal indentation\n"""';
    const input = {
        key: "python-nested-default",
        source: `def outer():\n def inner(text=${literal}):\n  return text\n return inner()\n`,
        language: "python",
        mode: "statement" as const,
        complete: true,
        formatter: async ({ code }: { code: string }) => code,
    };
    store.get(input);
    await store.settled();
    expect(store.get(input)).toBe(
        `def outer():\n    def inner(text=${literal}):\n        return text\n    return inner()\n`,
    );
});

it.each(["def read():", "class Example:", "if True:", "for value in [1]:"])(
    "holds a Python header with only a streaming comment until a real suite statement exists: %s",
    async (header) => {
        const store = createCodeStreamStore();
        stores.push(store);
        const inputs: string[] = [];
        const input = {
            key: "comment-only-suite",
            source: `${header}\n # first`,
            language: "python",
            mode: "statement" as const,
            complete: false,
            formatter: async ({ code }: { code: string }) => {
                inputs.push(code);
                return code;
            },
        };
        store.get(input);
        await store.settled();
        expect(store.get(input)).toBe("");
        expect(inputs).toEqual([]);
        const body = {
            ...input,
            source: `${header}\n # first comment\n value=1\n # following comment`,
        };
        store.get(body);
        await store.settled();
        expect(store.get(body)).toBe(`${header}\n    # first comment\n    value=1`);
        const final = { ...body, source: body.source + "\n value=2\n", complete: true };
        store.get(final);
        await store.settled();
        expect(store.get(final)).toBe(
            `${header}\n    # first comment\n    value=1\n    # following comment\n    value=2\n`,
        );
    },
);

it("preserves malformed generated content without repeated session warnings on resize", async () => {
    const warnings: string[] = [];
    const binding = bindExtensionDiagnostics({
        hasUI: true,
        ui: {
            notify: (message) => {
                warnings.push(message);
            },
        },
    });
    warnings.length = 0;
    const store = createCodeStreamStore();
    stores.push(store);
    const input = {
        key: "invalid-content",
        source: "x=1\ny=(",
        language: "python",
        mode: "statement" as const,
        complete: true,
    };
    try {
        for (const targetWidth of [80, 40, 100]) {
            store.get({ ...input, targetWidth });
            await store.settled();
            expect(store.get({ ...input, targetWidth })).toBe(input.source);
        }

        expect(warnings).toEqual([]);
    } finally {
        binding.dispose();
    }
});
