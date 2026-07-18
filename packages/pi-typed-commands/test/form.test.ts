import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { openArgumentForm } from "../src/form.js";
import { DEFAULT_PI_TYPED_COMMANDS_APPEARANCE } from "../src/pi/presentation-config.js";
import type { FlatArgumentDefinitions, ParsedCommandArguments } from "../src/types.js";
import type { RegisteredTypedCommand } from "../src/pi/command-types.js";
import {
    createTestExtensionCommandContext,
    createTestKeybindings,
    createTestTheme,
    createTestSignal,
    createTestTui,
    requireInteractiveComponent,
} from "./pi-test-adapter.js";

const symbols = {
    selectedCheckbox: "■",
    unselectedCheckbox: "□",
    selectedRadio: "●",
    unselectedRadio: "○",
};

const theme = createTestTheme();

const formOptions = { appearance: DEFAULT_PI_TYPED_COMMANDS_APPEARANCE };

const tui = createTestTui();
const keybindings = createTestKeybindings();

describe("dense argument form", () => {
    it("shows field names instead of CLI flags in validation messages", async () => {
        const definitions = {
            count: { type: "number", integer: true, max: 3, default: 1 },
        } satisfies FlatArgumentDefinitions;

        const command: RegisteredTypedCommand<typeof definitions> = {
            name: "example",
            description: "Example command",
            args: definitions,
            formSymbols: symbols,
        };

        const parsed: ParsedCommandArguments = {
            values: { count: 1 },
            provided: new Set(["count"]),
            issues: [
                {
                    kind: "invalid-value",
                    message: "--count must be at most 3",
                    name: "count",
                    token: "4",
                },
            ],
            mode: "run",
        };

        let renderedLines: string[] = [];
        const ctx = createTestExtensionCommandContext({
            mode: "tui",
            ui: {
                notify() {},
                custom: async (factory) => {
                    const component = requireInteractiveComponent(
                        await factory(tui, theme, keybindings, () => {}),
                    );

                    component.focused = true;
                    renderedLines = component.render(80);
                    return undefined;
                },
            },
        });

        await openArgumentForm(command, parsed, "missing", ctx, formOptions);

        assert.ok(
            renderedLines.some((line) => line.includes("count must be at most 3")),
            `expected field-name issue, got ${JSON.stringify(renderedLines)}`,
        );
        assert.ok(
            !renderedLines.some((line) => line.includes("--count must be at most 3")),
            `expected no CLI-flag issue, got ${JSON.stringify(renderedLines)}`,
        );
    });

    it("rejects non-number characters in number fields", async () => {
        const definitions = {
            count: { type: "number", integer: true, default: 1 },
        } satisfies FlatArgumentDefinitions;

        const command: RegisteredTypedCommand<typeof definitions> = {
            name: "example",
            description: "Example command",
            args: definitions,
            formSymbols: symbols,
        };

        const parsed: ParsedCommandArguments = {
            values: { count: 1 },
            provided: new Set(),
            issues: [],
            mode: "run",
        };

        let countLine = "";
        const ctx = createTestExtensionCommandContext({
            mode: "tui",
            ui: {
                notify() {},
                custom: async (factory) => {
                    let result: unknown;
                    const component = requireInteractiveComponent(
                        await factory(tui, theme, keybindings, (next: unknown) => {
                            result = next;
                        }),
                    );

                    component.focused = true;
                    component.handleInput("a");
                    component.handleInput("2b3");
                    countLine = component.render(80).find((line) => line.includes("count")) ?? "";
                    component.handleInput("\r");

                    return result;
                },
            },
        });

        const result = await openArgumentForm(command, parsed, "all", ctx, formOptions);

        assert.ok(
            countLine.includes("123"),
            `expected accepted digits only, got ${JSON.stringify(countLine)}`,
        );
        assert.ok(
            !countLine.includes("a") && !countLine.includes("b"),
            `expected rejected letters, got ${JSON.stringify(countLine)}`,
        );
        assert.equal(result?.count, 123);
    });

    it("uses field titles and whole-form values for custom widgets", async () => {
        const definitions: FlatArgumentDefinitions = {
            source: { type: "string", default: "api" },
            output: {
                type: "string",
                title: "Output path",
                ui: {
                    custom: {
                        renderValue(ctx) {
                            return `source=${ctx.formatValue(ctx.values.source)}`;
                        },
                    },
                },
            },
        };

        const command: RegisteredTypedCommand = {
            name: "example",
            description: "Example command",
            args: definitions,
            formSymbols: symbols,
        };
        const parsed: ParsedCommandArguments = {
            values: { source: "api" },
            provided: new Set(),
            issues: [],
            mode: "run",
        };

        let renderedLines: string[] = [];
        const ctx = createTestExtensionCommandContext({
            mode: "tui",
            ui: {
                notify() {},
                custom: async (factory) => {
                    const component = requireInteractiveComponent(
                        await factory(tui, theme, keybindings, () => {}),
                    );

                    component.focused = true;
                    component.handleInput("\t");
                    renderedLines = component.render(80);
                    return undefined;
                },
            },
        });

        await openArgumentForm(command, parsed, "all", ctx, formOptions);

        assert.ok(renderedLines.some((line) => line.includes("Output path")));
        assert.ok(renderedLines.some((line) => line.includes("source=api")));
    });

    it("widens the label column for readable field titles", async () => {
        const definitions: FlatArgumentDefinitions = {
            panes: {
                type: "boolean",
                default: false,
                title: "Current tab panes",
                description: "Split the current tab/window into panes",
            },
        };

        const command: RegisteredTypedCommand = {
            name: "example",
            description: "Example command",
            args: definitions,
            formSymbols: symbols,
        };
        const parsed: ParsedCommandArguments = {
            values: { panes: false },
            provided: new Set(),
            issues: [],
            mode: "run",
        };

        let renderedLines: string[] = [];
        const ctx = createTestExtensionCommandContext({
            mode: "tui",
            ui: {
                notify() {},
                custom: async (factory) => {
                    const component = requireInteractiveComponent(
                        await factory(tui, theme, keybindings, () => {}),
                    );

                    component.focused = true;
                    renderedLines = component.render(80);
                    return undefined;
                },
            },
        });

        await openArgumentForm(command, parsed, "all", ctx, formOptions);

        assert.ok(
            renderedLines.some((line) => line.includes("Current tab panes")),
            `expected full field title, got ${JSON.stringify(renderedLines)}`,
        );
        assert.ok(
            !renderedLines.some((line) => line.includes("Current tab…")),
            `expected no truncated field title, got ${JSON.stringify(renderedLines)}`,
        );
    });

    it("renders descriptions beside individual radio enum options", async () => {
        const definitions = {
            layout: {
                type: "enum",
                values: ["separate", "current-tab", "new-tab"],
                default: "separate",
                title: "Where to open forks",
                optionDescriptions: {
                    separate: "One tab/window per fork",
                    "current-tab": "Add panes beside this Pi",
                    "new-tab": "Put all forks in one split tab/window",
                },
                ui: { widget: "radio" },
            },
        } satisfies FlatArgumentDefinitions;
        const command: RegisteredTypedCommand<typeof definitions> = {
            name: "example",
            description: "Example command",
            args: definitions,
            formSymbols: symbols,
        };
        const parsed: ParsedCommandArguments = {
            values: { layout: "separate" },
            provided: new Set(),
            issues: [],
            mode: "run",
        };

        let renderedLines: string[] = [];
        const ctx = createTestExtensionCommandContext({
            mode: "tui",
            ui: {
                notify() {},
                custom: async (factory) => {
                    const component = requireInteractiveComponent(
                        await factory(tui, theme, keybindings, () => {}),
                    );

                    component.focused = true;
                    renderedLines = component.render(120);
                    return undefined;
                },
            },
        });

        await openArgumentForm(command, parsed, "all", ctx, formOptions);

        assert.ok(
            renderedLines.some(
                (line) => line.includes("● separate") && line.includes("One tab/window per fork"),
            ),
            JSON.stringify(renderedLines),
        );
        assert.ok(
            renderedLines.some(
                (line) =>
                    line.includes("○ current-tab") && line.includes("Add panes beside this Pi"),
            ),
            JSON.stringify(renderedLines),
        );
        assert.ok(
            renderedLines.some(
                (line) =>
                    line.includes("○ new-tab") &&
                    line.includes("Put all forks in one split tab/window"),
            ),
            JSON.stringify(renderedLines),
        );

        const optionLines = renderedLines.filter((line) =>
            ["● separate", "○ current-tab", "○ new-tab"].some((option) => line.includes(option)),
        );
        const descriptionColumns = [
            optionLines.find((line) => line.includes("● separate"))?.indexOf("One tab/window"),
            optionLines.find((line) => line.includes("○ current-tab"))?.indexOf("Add panes"),
            optionLines.find((line) => line.includes("○ new-tab"))?.indexOf("Put all forks"),
        ];
        assert.equal(optionLines.length, 3, JSON.stringify(renderedLines));
        assert.ok(descriptionColumns[0] !== undefined && descriptionColumns[0] >= 0);
        assert.deepEqual(descriptionColumns, [
            descriptionColumns[0],
            descriptionColumns[0],
            descriptionColumns[0],
        ]);
    });

    it("marks and highlights the currently selected field", async () => {
        const definitions: FlatArgumentDefinitions = {
            count: { type: "number", integer: true, default: 1, title: "Count" },
            panes: { type: "boolean", default: false, title: "Current tab panes" },
        };

        const command: RegisteredTypedCommand = {
            name: "example",
            description: "Example command",
            args: definitions,
            formSymbols: symbols,
        };
        const parsed: ParsedCommandArguments = {
            values: { count: 1, panes: false },
            provided: new Set(),
            issues: [],
            mode: "run",
        };

        let initialLines: string[] = [];
        let afterTabLines: string[] = [];
        const ctx = createTestExtensionCommandContext({
            mode: "tui",
            ui: {
                notify() {},
                custom: async (factory) => {
                    const component = requireInteractiveComponent(
                        await factory(tui, theme, keybindings, () => {}),
                    );

                    component.focused = true;
                    initialLines = component.render(80);
                    component.handleInput("\t");
                    afterTabLines = component.render(80);
                    return undefined;
                },
            },
        });

        await openArgumentForm(command, parsed, "all", ctx, formOptions);

        assert.ok(
            initialLines.some((line) => line.includes("› Count")),
            `expected selected marker on initial field, got ${JSON.stringify(initialLines)}`,
        );
        assert.ok(
            afterTabLines.some((line) => line.includes("› Current tab panes")),
            `expected selected marker after tab, got ${JSON.stringify(afterTabLines)}`,
        );
    });

    it("renders multiline textareas without embedding terminal line breaks in form rows", async () => {
        const definitions = {
            task: {
                type: "string",
                title: "Goal request",
                ui: { widget: "textarea", rows: 5 },
            },
            exact: { type: "boolean", title: "Use exact wording" },
        } satisfies FlatArgumentDefinitions;
        const command: RegisteredTypedCommand<typeof definitions> = {
            name: "multiline",
            description: "Multiline form",
            args: definitions,
            formSymbols: symbols,
        };
        const parsed: ParsedCommandArguments = {
            values: { task: "first\nsecond", exact: false },
            provided: new Set(["task"]),
            issues: [],
            mode: "run",
        };

        let selectedLines: string[] = [];
        let collapsedLines: string[] = [];
        const ctx = createTestExtensionCommandContext({
            mode: "tui",
            ui: {
                custom: async (factory) => {
                    const component = requireInteractiveComponent(
                        await factory(tui, theme, keybindings, () => {}),
                    );
                    component.focused = true;
                    component.handleInput("\u001b[200~\nthird\u001b[201~");
                    selectedLines = component.render(100);
                    component.handleInput("\t");
                    collapsedLines = component.render(100);
                    return undefined;
                },
            },
        });

        await openArgumentForm(command, parsed, "all", ctx, formOptions);

        for (const line of [...selectedLines, ...collapsedLines]) {
            assert.doesNotMatch(line, /[\r\n]/);
        }
        assert.equal(
            selectedLines.filter((line) => line.includes("Goal request")).length,
            1,
            JSON.stringify(selectedLines),
        );
        assert.ok(selectedLines.some((line) => line.includes("first")));
        assert.ok(selectedLines.some((line) => line.includes("second")));
        assert.ok(selectedLines.some((line) => line.includes("third")));
        assert.ok(
            collapsedLines.some((line) => line.includes("first ↵ second ↵ third")),
            JSON.stringify(collapsedLines),
        );
    });

    it("computes read-only field values", async () => {
        const definitions: FlatArgumentDefinitions = {
            source: { type: "string", default: "api" },
            output: {
                type: "string",
                ui: {
                    compute(values) {
                        const source = values.source;
                        if (typeof source !== "string") {
                            return undefined;
                        }
                        return `${source}.txt`;
                    },
                },
            },
        };
        const command: RegisteredTypedCommand = {
            name: "example",
            description: "Example command",
            args: definitions,
            formSymbols: symbols,
        };
        const parsed: ParsedCommandArguments = {
            values: { source: "api" },
            provided: new Set(),
            issues: [],
            mode: "run",
        };
        const ctx = createTestExtensionCommandContext({
            mode: "tui",
            ui: {
                notify() {},
                custom: async (factory) => {
                    let result: unknown;
                    const component = requireInteractiveComponent(
                        await factory(tui, theme, keybindings, (next: unknown) => {
                            result = next;
                        }),
                    );

                    component.focused = true;
                    component.handleInput("\r");
                    return result;
                },
            },
        });

        const result = await openArgumentForm(command, parsed, "all", ctx, formOptions);

        assert.equal(result?.output, "api.txt");
    });

    it("moves the cursor to the end when tabbing into a defaulted number field", async () => {
        const definitions = {
            label: { type: "string" },
            count: { type: "number", integer: true, default: 1 },
        } satisfies FlatArgumentDefinitions;

        const command: RegisteredTypedCommand<typeof definitions> = {
            name: "example",
            description: "Example command",
            args: definitions,
            formSymbols: symbols,
        };

        const parsed: ParsedCommandArguments = {
            values: { count: 1 },
            provided: new Set(),
            issues: [],
            mode: "run",
        };

        let countLine = "";
        const ctx = createTestExtensionCommandContext({
            mode: "tui",
            ui: {
                notify() {},
                custom: async (factory) => {
                    let result: unknown;
                    const component = requireInteractiveComponent(
                        await factory(tui, theme, keybindings, (next: unknown) => {
                            result = next;
                        }),
                    );

                    component.focused = true;
                    component.handleInput("\t");
                    countLine = component.render(80).find((line) => line.includes("count")) ?? "";
                    component.handleInput("6");
                    component.handleInput("\r");

                    return result;
                },
            },
        });

        const result = await openArgumentForm(command, parsed, "all", ctx, formOptions);

        assert.ok(
            countLine.includes(`1${CURSOR_MARKER}`),
            `expected cursor after defaulted number, got ${JSON.stringify(countLine)}`,
        );
        assert.equal(result?.count, 16);
    });

    it("cancels the form when Escape is pressed", async () => {
        const command: RegisteredTypedCommand = {
            name: "escape-cancel",
            description: "Escape cancellation",
            args: { path: { type: "string", required: true } },
            formSymbols: symbols,
        };
        const parsed: ParsedCommandArguments = {
            values: {},
            provided: new Set(),
            issues: [
                {
                    kind: "missing-required",
                    message: "--path is required",
                    name: "path",
                },
            ],
            mode: "run",
        };
        let doneCalled = false;
        const ctx = createTestExtensionCommandContext({
            mode: "tui",
            ui: {
                custom: async (factory) => {
                    let result: unknown;
                    const component = requireInteractiveComponent(
                        await factory(tui, theme, keybindings, (next: unknown) => {
                            doneCalled = true;
                            result = next;
                        }),
                    );
                    component.focused = true;
                    component.handleInput("\u001b");
                    return result;
                },
            },
        });

        const result = await openArgumentForm(command, parsed, "all", ctx, formOptions);

        assert.equal(doneCalled, true);
        assert.equal(result, undefined);
    });

    it("keeps the dense form open for cross-field refinement and highlights related fields", async () => {
        const definitions = {
            start: { type: "number", required: true },
            end: { type: "number", required: true },
        } satisfies FlatArgumentDefinitions;
        const command: RegisteredTypedCommand<typeof definitions> = {
            name: "range-form-test",
            description: "Range",
            args: definitions,
            refine(values) {
                if (
                    typeof values.start === "number" &&
                    typeof values.end === "number" &&
                    values.start > values.end
                ) {
                    return [
                        {
                            code: "range.invalid",
                            message: "start must not exceed end",
                            path: ["start"],
                            relatedPaths: [["end"]],
                        },
                    ];
                }
                return [];
            },
            formSymbols: symbols,
        };
        const parsed: ParsedCommandArguments = {
            values: { start: 10, end: 5 },
            provided: new Set(["start", "end"]),
            issues: [],
            mode: "run",
        };
        let firstSubmitCompleted = false;
        let issueLines: string[] = [];
        const ctx = createTestExtensionCommandContext({
            mode: "tui",
            ui: {
                custom: async (factory) => {
                    let result: unknown;
                    const component = requireInteractiveComponent(
                        await factory(tui, theme, keybindings, (next: unknown) => {
                            firstSubmitCompleted = true;
                            result = next;
                        }),
                    );
                    component.focused = true;
                    component.handleInput("\r");
                    issueLines = component.render(80);
                    assert.equal(firstSubmitCompleted, false);
                    component.handleInput("\u007f");
                    component.handleInput("\u007f");
                    component.handleInput("1");
                    component.handleInput("\r");
                    return result;
                },
            },
        });

        const result = await openArgumentForm(command, parsed, "all", ctx, formOptions);

        assert.ok(issueLines.some((line) => line.includes("start must not exceed end")));
        assert.equal(result?.start, 1);
        assert.equal(result?.end, 5);
    });

    it("uses Pi's injected user-configured semantic keybindings and hints", async () => {
        const command: RegisteredTypedCommand = {
            name: "keybinding-form-test",
            description: "Configured keys",
            args: { enabled: { type: "boolean", default: false } },
            formSymbols: symbols,
        };
        const parsed: ParsedCommandArguments = {
            values: { enabled: false },
            provided: new Set(),
            issues: [],
            mode: "run",
        };
        const configuredKeybindings = createTestKeybindings({
            "tui.input.submit": "ctrl+s",
            "tui.input.tab": "ctrl+n",
            "tui.select.cancel": "ctrl+x",
        });
        let renderedLines: string[] = [];
        const ctx = createTestExtensionCommandContext({
            mode: "tui",
            ui: {
                custom: async (factory) => {
                    let result: unknown;
                    const component = requireInteractiveComponent(
                        await factory(tui, theme, configuredKeybindings, (next: unknown) => {
                            result = next;
                        }),
                    );
                    component.focused = true;
                    renderedLines = component.render(80);
                    component.handleInput("\u0013");
                    return result;
                },
            },
        });

        const result = await openArgumentForm(command, parsed, "all", ctx, formOptions);

        assert.ok(renderedLines.some((line) => line.includes("ctrl+s submit")));
        assert.ok(renderedLines.some((line) => line.includes("ctrl+n move")));
        assert.ok(renderedLines.some((line) => line.includes("ctrl+x cancel")));
        assert.equal(result?.enabled, false);
    });
});

describe("sequential argument form", () => {
    it("cancels pending input through the caller AbortSignal without applying its stale value", async () => {
        const definitions = {
            path: { type: "string" },
        } satisfies FlatArgumentDefinitions;
        const command: RegisteredTypedCommand<typeof definitions> = {
            name: "cancel-input",
            description: "Cancel pending input",
            args: definitions,
            formSymbols: symbols,
        };
        const parsed: ParsedCommandArguments = {
            values: {},
            provided: new Set(),
            issues: [],
            mode: "run",
        };
        const controller = new AbortController();
        const promptStarted = createTestSignal<AbortSignal | undefined>();
        const promptCompletion = createTestSignal<string | undefined>();
        const notifications: string[] = [];
        const ctx = createTestExtensionCommandContext({
            mode: "rpc",
            ui: {
                input(_title, _placeholder, options) {
                    promptStarted.resolve(options?.signal);
                    return promptCompletion.promise;
                },
                notify(message) {
                    notifications.push(message);
                },
            },
        });

        const formCompletion = openArgumentForm(command, parsed, "all", ctx, {
            ...formOptions,
            signal: controller.signal,
        });
        const receivedSignal = await promptStarted.promise;
        assert.equal(receivedSignal, controller.signal);

        controller.abort();
        promptCompletion.resolve("stale.txt");

        assert.equal(await formCompletion, undefined);
        assert.deepEqual(notifications, []);
    });

    it("cancels pending selection through the caller AbortSignal without applying its stale value", async () => {
        const definitions = {
            enabled: { type: "boolean" },
        } satisfies FlatArgumentDefinitions;
        const command: RegisteredTypedCommand<typeof definitions> = {
            name: "cancel-selection",
            description: "Cancel pending selection",
            args: definitions,
            formSymbols: symbols,
        };
        const parsed: ParsedCommandArguments = {
            values: {},
            provided: new Set(),
            issues: [],
            mode: "run",
        };
        const controller = new AbortController();
        const promptStarted = createTestSignal<AbortSignal | undefined>();
        const promptCompletion = createTestSignal<string | undefined>();
        const notifications: string[] = [];
        const ctx = createTestExtensionCommandContext({
            mode: "rpc",
            ui: {
                notify(message) {
                    notifications.push(message);
                },
                select(_title, _options, dialogOptions) {
                    promptStarted.resolve(dialogOptions?.signal);
                    return promptCompletion.promise;
                },
            },
        });

        const formCompletion = openArgumentForm(command, parsed, "all", ctx, {
            ...formOptions,
            signal: controller.signal,
        });
        const receivedSignal = await promptStarted.promise;
        assert.equal(receivedSignal, controller.signal);

        controller.abort();
        promptCompletion.resolve("true");

        assert.equal(await formCompletion, undefined);
        assert.deepEqual(notifications, []);
    });

    it("runs command refinement after collecting form values", async () => {
        const definitions = {
            start: { type: "number", required: true },
            end: { type: "number", required: true },
        } satisfies FlatArgumentDefinitions;

        const command: RegisteredTypedCommand<typeof definitions> = {
            name: "range",
            description: "Range command",
            args: definitions,
            refine(args) {
                if (
                    typeof args.start === "number" &&
                    typeof args.end === "number" &&
                    args.start > args.end
                ) {
                    return [{ message: "start must not exceed end", path: ["start"] }];
                }
                return [];
            },
            formSymbols: symbols,
        };

        const parsed: ParsedCommandArguments = {
            values: { start: 10 },
            provided: new Set(["start"]),
            issues: [
                {
                    kind: "missing-required",
                    message: "--end is required",
                    name: "end",
                },
            ],
            mode: "run",
        };
        const notifications: string[] = [];
        const ctx = createTestExtensionCommandContext({
            mode: "rpc",
            ui: {
                notify(message: string) {
                    notifications.push(message);
                },
                input() {
                    return Promise.resolve("5");
                },
            },
        });

        const result = await openArgumentForm(command, parsed, "missing", ctx, formOptions);

        assert.equal(result, undefined);
        assert.deepEqual(notifications, ["• end is required", "• start must not exceed end"]);
    });

    it("prompts for multi-enum values outside TUI mode", async () => {
        const definitions = {
            tags: {
                type: "multi-enum",
                values: ["api", "web", "worker"],
                required: true,
                minItems: 2,
            },
        } satisfies FlatArgumentDefinitions;

        const command: RegisteredTypedCommand<typeof definitions> = {
            name: "example",
            description: "Example command",
            args: definitions,
            formSymbols: symbols,
        };

        const parsed: ParsedCommandArguments = {
            values: {},
            provided: new Set(),
            issues: [
                {
                    kind: "missing-required",
                    message: "--tags is required",
                    name: "tags",
                },
            ],
            mode: "run",
        };
        const prompts: string[] = [];
        const notifications: string[] = [];
        const ctx = createTestExtensionCommandContext({
            mode: "rpc",
            ui: {
                notify(message: string) {
                    notifications.push(message);
                },
                input(title: string) {
                    prompts.push(title);
                    return Promise.resolve("api,worker");
                },
            },
        });

        const result = await openArgumentForm(command, parsed, "missing", ctx, formOptions);

        assert.deepEqual(result?.tags, ["api", "worker"]);
        assert.deepEqual(prompts, ["Set --tags (current: )"]);
        assert.deepEqual(notifications, ["• tags is required"]);
    });
});
