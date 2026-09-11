import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { openArgumentForm } from "../src/form.js";
import { DEFAULT_PI_TYPED_COMMANDS_APPEARANCE } from "../src/pi/presentation-config.js";
import type {
    ArgumentValue,
    FlatArgumentDefinitions,
    ParsedCommandArguments,
} from "../src/types.js";
import type { RegisteredTypedCommand } from "../src/pi/command-types.js";
import { createTestExtensionCommandContext } from "./pi-test-adapter.js";

const formOptions = { appearance: DEFAULT_PI_TYPED_COMMANDS_APPEARANCE };

type PromptRecorder = {
    readonly inputs: Array<{
        title: string;
        placeholder: string | undefined;
    }>;

    readonly selects: Array<{
        title: string;
        options: readonly string[];
    }>;

    readonly notifications: Array<{ message: string; level: string | undefined }>;
};

type PromptContext = {
    ctx: ReturnType<typeof createTestExtensionCommandContext>;
    recorder: PromptRecorder;
};

function createPromptContext(
    inputResponses: Array<string | undefined> = [],
    selectResponses: Array<string | undefined> = [],
): PromptContext {
    const recorder: PromptRecorder = {
        inputs: [],
        selects: [],
        notifications: [],
    };
    const ctx = createTestExtensionCommandContext({
        mode: "rpc",
        ui: {
            async input(title, placeholder) {
                recorder.inputs.push({ title, placeholder });
                return Promise.resolve(inputResponses.shift());
            },
            async select(title, options) {
                recorder.selects.push({ title, options });
                return Promise.resolve(selectResponses.shift());
            },
            notify(message, level) {
                recorder.notifications.push({ message, level });
            },
        },
    });

    return { ctx, recorder };
}

function parsedValues(values: Record<string, ArgumentValue> = {}): ParsedCommandArguments {
    return {
        values,
        provided: new Set(),
        issues: [],
        mode: "run",
    };
}

function valueText(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    return JSON.stringify(value) ?? "";
}

function command<TDefinitions extends FlatArgumentDefinitions>(
    args: TDefinitions,
    refine?: RegisteredTypedCommand<TDefinitions>["refine"],
): RegisteredTypedCommand<TDefinitions> {
    const base = {
        name: "sequential-test",
        description: "Sequential form test",
        args,
        formSymbols: {
            selectedCheckbox: "■",
            unselectedCheckbox: "□",
            selectedRadio: "●",
            unselectedRadio: "○",
        },
    };
    if (refine === undefined) {
        return base;
    }

    return { ...base, refine };
}

describe("sequential argument form", () => {
    it("preserves negative zero in a number prompt", async () => {
        const definitions = {
            amount: { type: "number" },
        } satisfies FlatArgumentDefinitions;
        const { ctx, recorder } = createPromptContext(["-0"]);

        const result = await openArgumentForm(
            command(definitions),
            parsedValues({ amount: -0 }),
            "all",
            ctx,
            formOptions,
        );

        assert.equal(recorder.inputs[0]?.placeholder, "-0");
        assert.equal(Object.is(result?.amount, -0), true);
    });

    it("keeps absent Object prototype spellings unset in sequential form state", async () => {
        const definitions = {
            toString: { type: "string" as const },
        };
        const { ctx, recorder } = createPromptContext([""]);

        const result = await openArgumentForm(
            command(definitions),
            parsedValues(),
            "all",
            ctx,
            formOptions,
        );

        assert.equal(recorder.inputs[0]?.placeholder, "");

        if (result === undefined) {
            assert.fail("expected sequential form state");
        }

        assert.equal(Object.getPrototypeOf(result), Object.prototype);
        assert.equal(Object.hasOwn(result, "toString"), true);
        assert.deepEqual(Object.getOwnPropertyDescriptor(result, "toString"), {
            configurable: true,
            enumerable: true,
            value: undefined,
            writable: true,
        });
        assert.deepEqual(Object.keys(result), ["toString"]);
        assert.deepEqual(Object.entries(result), [["toString", undefined]]);
    });

    it("collects string, number, list, key-value, boolean, enum, and multi-enum values", async () => {
        const definitions = {
            text: { type: "string", required: true, description: "A text value" },
            count: { type: "number", required: true },
            tags: {
                type: "multi-enum",
                values: ["api", "web", "worker"],
                required: true,
            },
            labels: { type: "string-list" },
            variables: { type: "key-value" },
            enabled: { type: "boolean", required: true },
            mode: { type: "enum", values: ["fast", "safe"], required: true },
        } satisfies FlatArgumentDefinitions;
        const { ctx, recorder } = createPromptContext(
            ["hello", "42", "api,worker", "one,two", "MODE=safe,TRACE=1"],
            ["true", "safe"],
        );

        const result = await openArgumentForm(
            command(definitions),
            parsedValues({ labels: ["existing"], variables: { MODE: "old" } }),
            "all",
            ctx,
            formOptions,
        );

        assert.deepEqual(result, {
            text: "hello",
            count: 42,
            tags: ["api", "worker"],
            labels: ["one", "two"],
            variables: { MODE: "safe", TRACE: "1" },
            enabled: true,
            mode: "safe",
        });
        assert.deepEqual(
            recorder.inputs.map(({ title, placeholder }) => ({ title, placeholder })),
            [
                { title: "Set --text — A text value (current: )", placeholder: "" },
                { title: "Set --count (current: )", placeholder: "" },
                { title: "Set --tags (current: )", placeholder: "api,web,worker" },
                { title: "Set --labels (current: existing)", placeholder: "existing" },
                {
                    title: "Set --variables (current: MODE=old)",
                    placeholder: "MODE=old",
                },
            ],
        );
        assert.deepEqual(recorder.selects, [
            { title: "Set --enabled", options: ["true", "false"] },
            { title: "Set --mode", options: ["fast", "safe"] },
        ]);
        assert.deepEqual(recorder.notifications, []);
    });

    it("applies defaults when optional select fields are explicitly left unset", async () => {
        const definitions = {
            environment: { type: "enum", values: ["dev", "prod"], default: "dev" },
            enabled: { type: "boolean", default: true },
        } satisfies FlatArgumentDefinitions;
        const { ctx, recorder } = createPromptContext([], ["", ""]);

        const result = await openArgumentForm(
            command(definitions),
            parsedValues(),
            "all",
            ctx,
            formOptions,
        );

        assert.deepEqual(result, { environment: "dev", enabled: true });
        assert.deepEqual(recorder.selects, [
            { title: "Set --environment", options: ["", "dev", "prod"] },
            { title: "Set --enabled", options: ["true", "false", ""] },
        ]);
    });

    it("uses copied and computed state while skipping conditional non-editable fields", async () => {
        const definitions = {
            source: { type: "string" },
            copied: { type: "string", ui: { copyFrom: "source" } },
            computed: {
                type: "string",
                ui: { compute: (values) => `${valueText(values.source)}-computed` },
            },
            hidden: { type: "string", ui: { hidden: true } },
            invisible: { type: "string", ui: { visibleWhen: false } },
            readOnly: { type: "string", ui: { readOnly: (values) => values.source === "base" } },
            disabled: { type: "string", ui: { disabled: true } },
            disabledByFunction: {
                type: "string",
                ui: { disabled: (values) => values.source === "base" },
            },
            disabledByEnabledWhen: {
                type: "string",
                ui: { enabledWhen: (values) => values.source !== "base" },
            },
            computedWidget: { type: "string", ui: { widget: "computed" } },
            readOnlyWidget: { type: "string", ui: { widget: "readonly" } },
            conditional: {
                type: "string",
                ui: { requiredWhen: (values) => values.source === "base" },
            },
        } satisfies FlatArgumentDefinitions;
        const { ctx, recorder } = createPromptContext(["required value"]);

        const result = await openArgumentForm(
            command(definitions),
            parsedValues({ source: "base" }),
            "missing",
            ctx,
            formOptions,
        );

        assert.deepEqual(result, {
            source: "base",
            copied: "base",
            computed: "base-computed",
            conditional: "required value",
        });
        assert.deepEqual(recorder.inputs, [
            { title: "Set --conditional (current: )", placeholder: "" },
        ]);
    });

    it("re-prompts after string, numeric, collection, and key-value validation failures", async () => {
        const definitions = {
            name: { type: "string", pattern: "^[a-z]+$" },
            count: { type: "number", integer: true },
            tags: { type: "multi-enum", values: ["a", "b"], minItems: 2 },
            variables: { type: "key-value" },
        } satisfies FlatArgumentDefinitions;
        const { ctx, recorder } = createPromptContext([
            "BAD",
            "good",
            "1.2",
            "3",
            "a",
            "a,b",
            "invalid",
            "MODE=safe",
        ]);

        const result = await openArgumentForm(
            command(definitions),
            parsedValues(),
            "all",
            ctx,
            formOptions,
        );

        assert.deepEqual(result, {
            name: "good",
            count: 3,
            tags: ["a", "b"],
            variables: { MODE: "safe" },
        });
        assert.deepEqual(
            recorder.notifications.map(({ message, level }) => ({ message, level })),
            [
                { message: "name must match pattern ^[a-z]+$", level: "error" },
                { message: "count expects an integer", level: "error" },
                { message: "tags must include at least 2 item(s)", level: "error" },
                { message: "variables expects key=value", level: "error" },
            ],
        );
    });

    it("handles empty text and multi-enum input using current values, defaults, and required retries", async () => {
        const definitions = {
            currentText: { type: "string" },
            defaultText: { type: "string", default: "fallback" },
            requiredText: { type: "string", required: true },
            optionalText: { type: "string" },
            currentTags: { type: "multi-enum", values: ["a", "b"] },
            defaultTags: { type: "multi-enum", values: ["a", "b"], default: ["a"] },
            requiredTags: { type: "multi-enum", values: ["a", "b"], required: true },
        } satisfies FlatArgumentDefinitions;
        const { ctx, recorder } = createPromptContext(["", "", "", "value", "", "", "", "", "a,b"]);

        const result = await openArgumentForm(
            command(definitions),
            parsedValues({ currentText: "keep", currentTags: ["b"] }),
            "all",
            ctx,
            formOptions,
        );

        assert.deepEqual(result, {
            currentText: "keep",
            defaultText: "fallback",
            requiredText: "value",
            optionalText: undefined,
            currentTags: ["b"],
            defaultTags: ["a"],
            requiredTags: ["a", "b"],
        });
        assert.deepEqual(
            recorder.notifications.map(({ message, level }) => ({ message, level })),
            [
                { message: "required-text is required", level: "error" },
                { message: "required-tags is required", level: "error" },
            ],
        );
    });

    it("reports final requiredness and validation issues for untouched form values", async () => {
        const definitions = {
            hiddenCount: { type: "number", ui: { hidden: true } },
            conditionalText: { type: "string", ui: { requiredWhen: true } },
        } satisfies FlatArgumentDefinitions;
        const { ctx, recorder } = createPromptContext([""]);

        const result = await openArgumentForm(
            command(definitions),
            parsedValues({ hiddenCount: "not-a-number" }),
            "missing",
            ctx,
            formOptions,
        );

        assert.equal(result, undefined);
        assert.deepEqual(recorder.notifications, [
            {
                message: "• hidden-count expects a number\n• conditional-text is required",
                level: "error",
            },
        ]);
    });

    it("stops when the user cancels a prompt without an abort signal", async () => {
        const definitions = {
            path: { type: "string", required: true },
        } satisfies FlatArgumentDefinitions;
        const { ctx, recorder } = createPromptContext([undefined]);

        const result = await openArgumentForm(
            command(definitions),
            parsedValues(),
            "all",
            ctx,
            formOptions,
        );

        assert.equal(result, undefined);
        assert.deepEqual(recorder.notifications, []);
    });
});
