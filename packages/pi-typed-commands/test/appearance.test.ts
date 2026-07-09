import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import {
    CONFIG_DIR_NAME,
    type ExtensionAPI,
    type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { openArgumentForm } from "../src/form.js";
import {
    DEFAULT_PI_TYPED_COMMANDS_CONFIG_JSON,
    piTypedCommandsConfigJsonSchema,
} from "../src/pi/config-schema.js";
import { renderInlineHelper } from "../src/pi/helper.js";
import { parsePiTypedCommandsAppearance } from "../src/pi/presentation-config.js";
import {
    getPiTypedCommandsGlobalConfigPath,
    getPiTypedCommandsGlobalConfigSchemaPath,
    resolveTypedCommandAppearance,
} from "../src/pi/settings.js";
import { typedSkillCommandFromMetadata } from "../src/skills.js";
import { formatDetailedHelp } from "../src/usage.js";
import { installTypedCommandUx, registerTypedCommand } from "../src/index.js";
import { registerTypedCommandMetadata, unregisterTypedCommandMetadata } from "../src/registry.js";
import type {
    FlatArgumentDefinitions,
    ParsedCommandArguments,
    RegisteredTypedCommand,
} from "../src/types.js";

const formSymbols = {
    selectedCheckbox: "■",
    unselectedCheckbox: "□",
    selectedRadio: "●",
    unselectedRadio: "○",
};

const identityTheme = {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
};

const tui = {
    terminal: { rows: 24, columns: 80 },
    requestRender() {},
} as unknown as TUI;

type TestFormComponent = Component & {
    focused: boolean;
    render(width: number): string[];
};

type ExtensionEventHandler = (event: unknown, ctx: unknown) => unknown;

function withAgentDir<T>(agentDir: string, run: () => T): T {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
        return run();
    } finally {
        if (previousAgentDir === undefined) {
            delete process.env.PI_CODING_AGENT_DIR;
        } else {
            process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        }
    }
}

async function withAgentDirAsync<T>(agentDir: string, run: () => Promise<T>): Promise<T> {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
        return await run();
    } finally {
        if (previousAgentDir === undefined) {
            delete process.env.PI_CODING_AGENT_DIR;
        } else {
            process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        }
    }
}

function writeGlobalConfig(agentDir: string, config: unknown): void {
    const configDir = join(agentDir, "pi-typed-args");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify(config));
}

function writeProjectConfig(cwd: string, config: unknown): void {
    const configDir = join(cwd, CONFIG_DIR_NAME, "pi-typed-args");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify(config));
}

function firstHandler(
    handlers: Map<string, ExtensionEventHandler[]>,
    name: string,
): ExtensionEventHandler {
    const handler = handlers.get(name)?.[0];
    if (handler === undefined) {
        throw new Error(`missing ${name} handler`);
    }
    return handler;
}

function helperCommand(): RegisteredTypedCommand {
    return {
        name: "appearance-helper",
        description: "Appearance helper",
        args: {
            count: { type: "number", integer: true, position: 0, default: 1 },
            path: { type: "string", required: true },
            panes: { type: "boolean" },
        },
        formSymbols,
    };
}

describe("global presentation config", () => {
    it("scaffolds missing global config and schema files", () => {
        const agentDir = mkdtempSync(join(tmpdir(), "pi-typed-appearance-agent-"));

        withAgentDir(agentDir, () => {
            const appearance = resolveTypedCommandAppearance({ cwd: process.cwd() } as never);

            assert.equal(appearance.inlineHelp.order, "active-required-available");
            assert.deepEqual(
                JSON.parse(readFileSync(getPiTypedCommandsGlobalConfigPath(agentDir), "utf8")),
                DEFAULT_PI_TYPED_COMMANDS_CONFIG_JSON,
            );
            assert.deepEqual(
                JSON.parse(
                    readFileSync(getPiTypedCommandsGlobalConfigSchemaPath(agentDir), "utf8"),
                ),
                piTypedCommandsConfigJsonSchema(),
            );
        });
    });

    it("does not overwrite malformed existing global config", () => {
        const agentDir = mkdtempSync(join(tmpdir(), "pi-typed-appearance-agent-"));
        const configPath = getPiTypedCommandsGlobalConfigPath(agentDir);
        mkdirSync(join(configPath, ".."), { recursive: true });
        writeFileSync(configPath, "{not json");

        withAgentDir(agentDir, () => {
            const appearance = resolveTypedCommandAppearance({ cwd: process.cwd() } as never);

            assert.equal(appearance.inlineHelp.order, "active-required-available");
            assert.equal(readFileSync(configPath, "utf8"), "{not json");
        });
    });

    it("refreshes stale global schema without rewriting user config", () => {
        const agentDir = mkdtempSync(join(tmpdir(), "pi-typed-appearance-agent-"));
        const configPath = getPiTypedCommandsGlobalConfigPath(agentDir);
        const schemaPath = getPiTypedCommandsGlobalConfigSchemaPath(agentDir);
        mkdirSync(join(configPath, ".."), { recursive: true });
        writeFileSync(configPath, "{not json");
        writeFileSync(schemaPath, "{}\n");

        withAgentDir(agentDir, () => {
            const appearance = resolveTypedCommandAppearance({ cwd: process.cwd() } as never);

            assert.equal(appearance.inlineHelp.order, "active-required-available");
            assert.equal(readFileSync(configPath, "utf8"), "{not json");
            assert.deepEqual(
                JSON.parse(readFileSync(schemaPath, "utf8")),
                piTypedCommandsConfigJsonSchema(),
            );
        });
    });

    it("refreshes stale global schema without rewriting user config", () => {
        const agentDir = mkdtempSync(join(tmpdir(), "pi-typed-appearance-agent-"));
        const configPath = getPiTypedCommandsGlobalConfigPath(agentDir);
        const schemaPath = getPiTypedCommandsGlobalConfigSchemaPath(agentDir);
        mkdirSync(join(configPath, ".."), { recursive: true });
        writeFileSync(configPath, "{not json");
        writeFileSync(schemaPath, "{}\n");

        withAgentDir(agentDir, () => {
            const appearance = resolveTypedCommandAppearance({ cwd: process.cwd() } as never);

            assert.equal(appearance.inlineHelp.order, "active-required-available");
            assert.equal(readFileSync(configPath, "utf8"), "{not json");
            assert.deepEqual(
                JSON.parse(readFileSync(schemaPath, "utf8")),
                piTypedCommandsConfigJsonSchema(),
            );
        });
    });

    it("parses global appearance settings and safely falls back for invalid values", () => {
        const appearance = parsePiTypedCommandsAppearance({
            form: {
                colors: {
                    title: "success",
                    focusedLabel: "\u001b[31m",
                },
                symbols: {
                    focusedField: "»",
                    selectedCheckbox: "",
                },
                layout: {
                    leftPadding: 3,
                    minValueWidth: 80,
                    maxNameWidth: -1,
                    descriptions: "hidden",
                },
            },
            inlineHelp: {
                order: "available-required-active",
                metadata: { types: true },
                colors: { active: "toolTitle", issue: "not-a-role" },
            },
        });

        assert.equal(appearance.form.colors.title, "success");
        assert.equal(appearance.form.colors.focusedLabel, "accent");
        assert.equal(appearance.form.symbols.focusedField, "»");
        assert.equal(appearance.form.symbols.selectedCheckbox, "■");
        assert.equal(appearance.form.symbolOverrides.selectedCheckbox, undefined);
        assert.equal(appearance.form.layout.leftPadding, 3);
        assert.equal(appearance.form.layout.maxValueWidth, 80);
        assert.equal(appearance.form.layout.maxNameWidth, 24);
        assert.equal(appearance.form.layout.descriptions, "hidden");
        assert.equal(appearance.inlineHelp.order, "available-required-active");
        assert.equal(appearance.inlineHelp.metadata.types, true);
        assert.equal(appearance.inlineHelp.colors.active, "toolTitle");
        assert.equal(appearance.inlineHelp.colors.issue, "error");
    });

    it("uses project config as an appearance override", () => {
        const agentDir = mkdtempSync(join(tmpdir(), "pi-typed-appearance-agent-"));
        const projectDir = mkdtempSync(join(tmpdir(), "pi-typed-appearance-project-"));
        writeGlobalConfig(agentDir, {
            appearance: { form: { symbols: { focusedField: "G" } } },
        });
        writeProjectConfig(projectDir, {
            appearance: { form: { symbols: { focusedField: "P" } } },
        });

        withAgentDir(agentDir, () => {
            const appearance = resolveTypedCommandAppearance({
                cwd: projectDir,
                isProjectTrusted: () => true,
            } as never);

            assert.equal(appearance.form.symbols.focusedField, "P");
        });
    });

    it("keeps default inline helper output unchanged", () => {
        const command = helperCommand();
        const [line] = renderInlineHelper(
            { command, rawArgs: "1 --panes", trailingBody: "" },
            200,
            identityTheme,
        );

        assert.equal(
            line,
            `${" ".repeat("/appearance-helper".length + 2)}` +
                "[count=1] [--panes]  [--path <path>]",
        );
    });

    it("renders type-rich inline helper tokens and custom ordering", () => {
        const command = helperCommand();
        const appearance = parsePiTypedCommandsAppearance({
            inlineHelp: {
                order: "available-required-active",
                metadata: { types: true },
            },
        }).inlineHelp;

        const [line] = renderInlineHelper(
            { command, rawArgs: "", trailingBody: "" },
            200,
            identityTheme,
            {},
            appearance,
        );
        const renderedLine = line ?? "";

        const availableIndex = renderedLine.indexOf("[--panes:boolean]");
        const requiredIndex = renderedLine.indexOf("[--path:string <path>]");
        const activeIndex = renderedLine.indexOf("[count:int=1]");
        assert.ok(availableIndex >= 0, renderedLine);
        assert.ok(requiredIndex > availableIndex, renderedLine);
        assert.ok(activeIndex > requiredIndex, renderedLine);
    });

    it("honors configured inline helper value separator in compact tokens", () => {
        const command = helperCommand();
        const appearance = parsePiTypedCommandsAppearance({
            inlineHelp: {
                format: { valueSeparator: " -> " },
            },
        }).inlineHelp;

        const [line] = renderInlineHelper(
            { command, rawArgs: "--path src", trailingBody: "" },
            200,
            identityTheme,
            {},
            appearance,
        );

        assert.equal(
            line,
            `${" ".repeat("/appearance-helper".length + 2)}` +
                "[count -> 1] [--path -> src]  [--panes]",
        );
    });

    it("applies configured inline helper colour roles", () => {
        const command = helperCommand();
        const appearance = parsePiTypedCommandsAppearance({
            inlineHelp: {
                colors: {
                    active: "success",
                    required: "error",
                    available: "borderMuted",
                    type: "syntaxType",
                    issue: "warning",
                },
                metadata: { types: true },
            },
        }).inlineHelp;
        const calls: string[] = [];
        const theme = {
            fg(color: string, text: string) {
                calls.push(color);
                return text;
            },
        };

        renderInlineHelper(
            { command, rawArgs: "bad --panes", trailingBody: "" },
            200,
            theme,
            { submittedInvalidEditorText: "/appearance-helper bad --panes" },
            appearance,
        );

        assert.ok(calls.includes("success"));
        assert.ok(calls.includes("error"));
        assert.ok(calls.includes("syntaxType"));
        assert.ok(calls.includes("warning"));
    });

    it("applies global form marker, symbols, layout, description, and footer modes", async () => {
        const agentDir = mkdtempSync(join(tmpdir(), "pi-typed-form-appearance-agent-"));
        const projectDir = mkdtempSync(join(tmpdir(), "pi-typed-form-appearance-project-"));
        writeGlobalConfig(agentDir, {
            appearance: {
                form: {
                    colors: {
                        title: "success",
                        focusedLabel: "toolTitle",
                        focusedValue: "syntaxString",
                    },
                    symbols: {
                        focusedField: "»",
                        selectedCheckbox: "☑",
                        unselectedCheckbox: "☐",
                    },
                    layout: {
                        leftPadding: 3,
                        fieldGap: 3,
                        descriptions: "hidden",
                        instructions: "hidden",
                    },
                },
            },
        });
        const definitions = {
            enabled: {
                type: "boolean",
                default: true,
                title: "Enabled",
                description: "turn it on",
            },
        } satisfies FlatArgumentDefinitions;
        const command: RegisteredTypedCommand<typeof definitions> = {
            name: "form-appearance",
            description: "Form appearance",
            args: definitions,
            formSymbols,
        };
        const parsed: ParsedCommandArguments = {
            values: { enabled: true },
            provided: new Set(),
            issues: [],
            mode: "run",
        };
        let renderedLines: string[] = [];
        const colorCalls: string[] = [];
        const recordingTheme = {
            bold: (text: string) => text,
            fg(color: string, text: string) {
                colorCalls.push(color);
                return text;
            },
        };
        const ctx = {
            cwd: projectDir,
            mode: "tui",
            ui: {
                notify() {},
                custom: async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => {
                    const component = (await factory(
                        tui,
                        recordingTheme as never,
                        {} as never,
                        () => {},
                    )) as TestFormComponent;
                    component.focused = true;
                    renderedLines = component.render(80);
                    return undefined;
                },
            },
        } as unknown as ExtensionCommandContext;

        await withAgentDirAsync(agentDir, () => openArgumentForm(command, parsed, "all", ctx));

        assert.ok(
            renderedLines.some((line) => line.startsWith("   » Enabled")),
            JSON.stringify(renderedLines),
        );
        assert.ok(
            renderedLines.some((line) => line.includes("☑")),
            JSON.stringify(renderedLines),
        );
        assert.ok(
            !renderedLines.some((line) => line.includes("turn it on")),
            JSON.stringify(renderedLines),
        );
        assert.ok(
            !renderedLines.some((line) => line.includes("esc cancel")),
            JSON.stringify(renderedLines),
        );
        assert.ok(colorCalls.includes("success"));
        assert.ok(colorCalls.includes("toolTitle"));
        assert.ok(colorCalls.includes("syntaxString"));
    });

    it("uses global appearance for typed skill inline help", async () => {
        const agentDir = mkdtempSync(join(tmpdir(), "pi-typed-skill-appearance-agent-"));
        writeGlobalConfig(agentDir, {
            appearance: {
                inlineHelp: {
                    format: { tokenPrefix: "<", tokenSuffix: ">" },
                },
            },
        });
        const command = typedSkillCommandFromMetadata({
            name: "appearance-demo",
            description: "Appearance demo",
            filePath: join(process.cwd(), "SKILL.md"),
            baseDir: process.cwd(),
            args: { path: { type: "string", required: true } },
            body: "Use {args.path}.",
        });

        const handlers = new Map<string, ExtensionEventHandler[]>();
        type HelperWidgetFactory = (
            tui: unknown,
            theme: { fg(color: string, text: string): string },
        ) => { render(width: number): string[] };
        let widgetFactory: HelperWidgetFactory | undefined;
        const pi = {
            on(name: string, handler: ExtensionEventHandler) {
                const current = handlers.get(name) ?? [];
                handlers.set(name, [...current, handler]);
            },
            getCommands() {
                return [];
            },
        } as unknown as ExtensionAPI;
        const ctx = {
            cwd: process.cwd(),
            hasUI: true,
            mode: "interactive",
            ui: {
                getEditorText() {
                    return "/skill:appearance-demo";
                },
                setWidget(_key: string, value: unknown) {
                    widgetFactory = value as HelperWidgetFactory | undefined;
                },
                onTerminalInput() {
                    return () => {};
                },
                addAutocompleteProvider() {},
                notify() {},
            },
        };

        try {
            await withAgentDirAsync(agentDir, async () => {
                installTypedCommandUx(pi);
                await firstHandler(handlers, "session_start")({}, ctx);
                registerTypedCommandMetadata(command);
            });

            if (widgetFactory === undefined) {
                assert.fail("expected helper widget to be installed");
            }
            const widget = widgetFactory(undefined, identityTheme);
            const [line] = widget.render(200);
            assert.match(line ?? "", /<--path <path>>/);
        } finally {
            await firstHandler(handlers, "session_shutdown")({}, ctx);
            unregisterTypedCommandMetadata(command);
        }
    });

    it("uses global detailed help settings through registered command help", async () => {
        const agentDir = mkdtempSync(join(tmpdir(), "pi-typed-help-appearance-agent-"));
        const projectDir = mkdtempSync(join(tmpdir(), "pi-typed-help-appearance-project-"));
        writeGlobalConfig(agentDir, {
            appearance: {
                detailedHelp: {
                    order: "required-first",
                },
            },
        });

        type RegisteredCommandOptions = {
            handler(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> | void;
        };

        let registeredHandler: RegisteredCommandOptions["handler"] | undefined;
        const pi = {
            registerCommand(_name: string, options: RegisteredCommandOptions) {
                registeredHandler = (rawArgs, ctx) => options.handler(rawArgs, ctx);
            },
        } as unknown as ExtensionAPI;
        const notifications: Array<{ message: string; level: string | undefined }> = [];
        const ctx = {
            cwd: projectDir,
            hasUI: true,
            mode: "interactive",
            ui: {
                notify(message: string, level?: string) {
                    notifications.push({ message, level });
                },
            },
        } as unknown as ExtensionCommandContext;

        const handle = registerTypedCommand(pi, {
            name: "help-settings",
            description: "Help settings",
            args: {
                ref: {
                    type: "string",
                    default: "main",
                    aliases: ["r"],
                    description: "Git ref",
                },
                env: {
                    type: "enum",
                    values: ["dev", "prod"],
                    required: true,
                    aliases: ["e"],
                    description: "Target env",
                },
            },
            run() {
                assert.fail("help should not run the command");
            },
        });

        try {
            await withAgentDirAsync(agentDir, async () => {
                if (registeredHandler === undefined) {
                    assert.fail("expected command handler to be registered");
                }
                await registeredHandler("--help", ctx);
            });

            assert.equal(notifications.length, 1);
            assert.equal(notifications[0]?.level, "info");
            const help = notifications[0]?.message ?? "";
            const envIndex = help.indexOf("  --env: dev|prod, required");
            const refIndex = help.indexOf("  --ref");
            assert.ok(envIndex >= 0, help);
            assert.ok(refIndex > envIndex, help);
            assert.doesNotMatch(help, /aliases --e/);
            assert.doesNotMatch(help, /aliases --r/);
        } finally {
            handle.dispose();
        }
    });

    it("formats detailed help with metadata options", () => {
        const command: RegisteredTypedCommand = {
            name: "help-appearance",
            description: "Help appearance",
            args: {
                env: {
                    type: "enum",
                    values: ["dev", "prod"],
                    required: true,
                    aliases: ["e"],
                    description: "Target env",
                },
                ref: { type: "string", default: "main", description: "Git ref" },
            },
            formSymbols,
        };

        const help = formatDetailedHelp(command, {
            order: "required-first",
            metadata: {
                types: true,
                defaults: false,
                required: true,
                aliases: true,
                descriptions: false,
                enumValues: false,
            },
        });

        assert.match(help, /--env: enum, required, aliases --e/);
        assert.doesNotMatch(help, /default main/);
        assert.doesNotMatch(help, /Target env/);
    });
});
