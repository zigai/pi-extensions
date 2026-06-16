import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type Component, type TUI } from "@earendil-works/pi-tui";
import { openArgumentForm } from "../src/form.js";
import type {
    ArgumentDefinitions,
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

void describe("dense argument form", () => {
    void it("moves the cursor to the end when tabbing into a defaulted number field", async () => {
        const definitions = {
            label: { type: "string" },
            count: { type: "number", integer: true, default: 1 },
        } satisfies ArgumentDefinitions;

        const command: RegisteredTypedCommand<typeof definitions> = {
            name: "example",
            description: "Example command",
            args: definitions,
            handler() {},
            typedArgsEnabled: true,
            formSymbols: symbols,
            openFormWhenInvalid: true,
            openFormWhenMissingRequired: true,
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
