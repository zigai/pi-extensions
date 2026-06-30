import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type Component, type TUI } from "@earendil-works/pi-tui";
import { openArgumentForm } from "../src/form.js";
import type {
    FlatArgumentDefinitions,
    ParsedCommandArguments,
    RegisteredTypedCommand,
} from "../src/types.js";

const symbols = {
    selectedCheckbox: "■",
    unselectedCheckbox: "□",
    selectedRadio: "●",
    unselectedRadio: "○",
};

const theme = {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
};

const tui = {
    terminal: { rows: 24, columns: 80 },
    requestRender() {},
} as unknown as TUI;

type TestFormComponent = Component & {
    focused: boolean;
    handleInput(data: string): void;
    render(width: number): string[];
};

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
        const ctx = {
            mode: "tui",
            ui: {
                notify() {},
                custom: async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => {
                    const component = (await factory(
                        tui,
                        theme as never,
                        {} as never,
                        () => {},
                    )) as TestFormComponent;

                    component.focused = true;
                    renderedLines = component.render(80);
                    return undefined;
                },
            },
        } as unknown as ExtensionCommandContext;

        await openArgumentForm(command, parsed, "missing", ctx);

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
        const ctx = {
            mode: "tui",
            ui: {
                notify() {},
                custom: async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => {
                    let result: unknown;
                    const component = (await factory(
                        tui,
                        theme as never,
                        {} as never,
                        (next: unknown) => {
                            result = next;
                        },
                    )) as TestFormComponent;

                    component.focused = true;
                    component.handleInput("a");
                    component.handleInput("2b3");
                    countLine = component.render(80).find((line) => line.includes("count")) ?? "";
                    component.handleInput("\r");

                    return result;
                },
            },
        } as unknown as ExtensionCommandContext;

        const result = await openArgumentForm(command, parsed, "all", ctx);

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
                            return `source=${String(ctx.values.source)}`;
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
        const ctx = {
            mode: "tui",
            ui: {
                notify() {},
                custom: async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => {
                    const component = (await factory(
                        tui,
                        theme as never,
                        {} as never,
                        () => {},
                    )) as TestFormComponent;

                    component.focused = true;
                    component.handleInput("\t");
                    renderedLines = component.render(80);
                    return undefined;
                },
            },
        } as unknown as ExtensionCommandContext;

        await openArgumentForm(command, parsed, "all", ctx);

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
        const ctx = {
            mode: "tui",
            ui: {
                notify() {},
                custom: async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => {
                    const component = (await factory(
                        tui,
                        theme as never,
                        {} as never,
                        () => {},
                    )) as TestFormComponent;

                    component.focused = true;
                    renderedLines = component.render(80);
                    return undefined;
                },
            },
        } as unknown as ExtensionCommandContext;

        await openArgumentForm(command, parsed, "all", ctx);

        assert.ok(
            renderedLines.some((line) => line.includes("Current tab panes")),
            `expected full field title, got ${JSON.stringify(renderedLines)}`,
        );
        assert.ok(
            !renderedLines.some((line) => line.includes("Current tab…")),
            `expected no truncated field title, got ${JSON.stringify(renderedLines)}`,
        );
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
        const ctx = {
            mode: "tui",
            ui: {
                notify() {},
                custom: async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => {
                    const component = (await factory(
                        tui,
                        theme as never,
                        {} as never,
                        () => {},
                    )) as TestFormComponent;

                    component.focused = true;
                    initialLines = component.render(80);
                    component.handleInput("\t");
                    afterTabLines = component.render(80);
                    return undefined;
                },
            },
        } as unknown as ExtensionCommandContext;

        await openArgumentForm(command, parsed, "all", ctx);

        assert.ok(
            initialLines.some((line) => line.includes("› Count")),
            `expected selected marker on initial field, got ${JSON.stringify(initialLines)}`,
        );
        assert.ok(
            afterTabLines.some((line) => line.includes("› Current tab panes")),
            `expected selected marker after tab, got ${JSON.stringify(afterTabLines)}`,
        );
    });

    it("computes read-only field values", async () => {
        const definitions: FlatArgumentDefinitions = {
            source: { type: "string", default: "api" },
            output: {
                type: "string",
                ui: {
                    compute(values) {
                        return `${String(values.source)}.txt`;
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
        const ctx = {
            mode: "tui",
            ui: {
                notify() {},
                custom: async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => {
                    let result: unknown;
                    const component = (await factory(
                        tui,
                        theme as never,
                        {} as never,
                        (next: unknown) => {
                            result = next;
                        },
                    )) as TestFormComponent;

                    component.focused = true;
                    component.handleInput("\r");
                    return result;
                },
            },
        } as unknown as ExtensionCommandContext;

        const result = await openArgumentForm(command, parsed, "all", ctx);

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
        const ctx = {
            mode: "tui",
            ui: {
                notify() {},
                custom: async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => {
                    let result: unknown;
                    const component = (await factory(
                        tui,
                        theme as never,
                        {} as never,
                        (next: unknown) => {
                            result = next;
                        },
                    )) as TestFormComponent;

                    component.focused = true;
                    component.handleInput("\t");
                    countLine = component.render(80).find((line) => line.includes("count")) ?? "";
                    component.handleInput("6");
                    component.handleInput("\r");

                    return result;
                },
            },
        } as unknown as ExtensionCommandContext;

        const result = await openArgumentForm(command, parsed, "all", ctx);

        assert.ok(
            countLine.includes(`1${CURSOR_MARKER}`),
            `expected cursor after defaulted number, got ${JSON.stringify(countLine)}`,
        );
        assert.equal(result?.count, 16);
    });
});

describe("sequential argument form", () => {
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
        const ctx = {
            mode: "rpc",
            ui: {
                notify(message: string) {
                    notifications.push(message);
                },
                input() {
                    return Promise.resolve("5");
                },
            },
        } as unknown as ExtensionCommandContext;

        const result = await openArgumentForm(command, parsed, "missing", ctx);

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
        const ctx = {
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
        } as unknown as ExtensionCommandContext;

        const result = await openArgumentForm(command, parsed, "missing", ctx);

        assert.deepEqual(result?.tags, ["api", "worker"]);
        assert.deepEqual(prompts, ["Set --tags (current: )"]);
        assert.deepEqual(notifications, ["• tags is required"]);
    });
});
