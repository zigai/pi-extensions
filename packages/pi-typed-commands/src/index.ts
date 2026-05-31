import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { getTypedArgumentCompletions, getTypedAutocompleteSuggestions } from "./completions.js";
import {
    getEnabledTypedCommands,
    getTypedCommand,
    isToggleEnabled,
    isTypedCommandEnabled,
    onTypedCommandsChanged,
    registerTypedCommandMetadata,
} from "./registry.js";
import { hasIssuesOfKind, parseTypedCommandArgs } from "./parser.js";
import type {
    ArgumentDefinitions,
    InferArguments,
    RegisteredTypedCommand,
    TypedCommandOptions,
    TypedCommandToggle,
    WizardMode,
} from "./types.js";
import { formatDetailedHelp, formatHelperLine } from "./usage.js";
import { openArgumentWizard } from "./wizard.js";

const WIDGET_KEY = "pi-command-args.helper";

export type TypedCommandUxOptions = {
    enabled?: TypedCommandToggle;
    registerListCommand?: boolean;
};

export type {
    ArgumentDefinition,
    ArgumentDefinitions,
    ArgumentValue,
    BooleanArgumentDefinition,
    EnumArgumentDefinition,
    InferArguments,
    NumberArgumentDefinition,
    ParsedCommandArguments,
    ParseIssue,
    ParseIssueKind,
    PrimitiveArgumentValue,
    RegisteredTypedCommand,
    StringArgumentDefinition,
    RawCommandHandler,
    TypedCommandHandler,
    TypedCommandOptions,
    TypedCommandToggle,
    WizardMode,
} from "./types.js";

export { formatCommandUsage, formatDetailedHelp, formatHelperLine } from "./usage.js";
export { getTypedCommand, getTypedCommands } from "./registry.js";
export { parseTypedCommandArgs } from "./parser.js";

function notifyIssues(ctx: ExtensionCommandContext, messages: string[]): void {
    if (messages.length === 0) {
        return;
    }
    ctx.ui.notify(messages.join("\n"), "error");
}

function shouldOpenWizard<TDefinitions extends ArgumentDefinitions>(
    command: RegisteredTypedCommand<TDefinitions>,
    parsedIssues: string[],
    parsedMode: "run" | "wizard" | "help",
): boolean {
    if (parsedMode === "wizard") {
        return true;
    }
    if (parsedIssues.length === 0) {
        return false;
    }
    return command.openWizardWhenInvalid;
}

async function resolveCommandArguments<TDefinitions extends ArgumentDefinitions>(
    command: RegisteredTypedCommand<TDefinitions>,
    rawArgs: string,
    ctx: ExtensionCommandContext,
): Promise<InferArguments<TDefinitions> | undefined> {
    const parsed = parseTypedCommandArgs(command, rawArgs);
    if (parsed.mode === "help") {
        ctx.ui.notify(formatDetailedHelp(command), "info");
        return undefined;
    }

    const issueMessages = parsed.issues.map((item) => item.message);
    let wizardMode: WizardMode = "missing";
    if (parsed.mode === "wizard") {
        wizardMode = "all";
    }

    let openWizard = shouldOpenWizard(command, issueMessages, parsed.mode);
    const hasMissingRequired = hasIssuesOfKind(parsed, ["missing-required"]);
    if (hasMissingRequired && command.openWizardWhenMissingRequired) {
        openWizard = true;
    }

    if (openWizard) {
        if (!ctx.hasUI) {
            notifyIssues(ctx, issueMessages);
            return undefined;
        }
        const collected = await openArgumentWizard(command, parsed, wizardMode, ctx);
        if (collected === undefined) {
            return undefined;
        }
        return collected as InferArguments<TDefinitions>;
    }

    if (issueMessages.length > 0) {
        notifyIssues(ctx, issueMessages);
        return undefined;
    }

    return parsed.values as InferArguments<TDefinitions>;
}

export function registerTypedCommand<TDefinitions extends ArgumentDefinitions>(
    pi: ExtensionAPI,
    name: string,
    options: TypedCommandOptions<TDefinitions>,
): void {
    const command: RegisteredTypedCommand<TDefinitions> = {
        name,
        description: options.description,
        args: options.args,
        handler: options.handler,
        typedArgsEnabled: options.typedArgsEnabled ?? true,
        manualWizardToken: options.manualWizardToken ?? "?",
        helpToken: options.helpToken ?? "??",
        openWizardWhenInvalid: options.openWizardWhenInvalid ?? true,
        openWizardWhenMissingRequired: options.openWizardWhenMissingRequired ?? true,
    };

    if (options.fallbackHandler !== undefined) {
        command.fallbackHandler = options.fallbackHandler;
    }

    registerTypedCommandMetadata(command);

    pi.registerCommand(name, {
        description: options.description,
        getArgumentCompletions(argumentPrefix) {
            return getTypedArgumentCompletions(command, argumentPrefix);
        },
        handler: async (rawArgs, ctx) => {
            if (!isTypedCommandEnabled(command)) {
                if (command.fallbackHandler !== undefined) {
                    await command.fallbackHandler(rawArgs, ctx);
                    return;
                }
                ctx.ui.notify(
                    `Typed args are disabled for /${name}, and no fallback handler is configured.`,
                    "warning",
                );
                return;
            }

            const args = await resolveCommandArguments(command, rawArgs, ctx);
            if (args === undefined) {
                return;
            }
            await command.handler(args, ctx);
        },
    });
}

function helperLineForEditorText(editorText: string): string | undefined {
    const firstLine = editorText.split("\n", 1)[0];
    if (firstLine === undefined) {
        return undefined;
    }

    const match = /^\/(\S+)/.exec(firstLine);
    if (match === null) {
        return undefined;
    }

    const commandName = match[1];
    if (commandName === undefined) {
        return undefined;
    }

    const command = getTypedCommand(commandName);
    if (command === undefined) {
        return undefined;
    }
    if (!isTypedCommandEnabled(command)) {
        return undefined;
    }

    if (Object.keys(command.args).length === 0) {
        return undefined;
    }

    return formatHelperLine(command);
}

function setHelperWidget(ctx: ExtensionContext, text: string | undefined): void {
    if (text === undefined) {
        ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
        return;
    }

    ctx.ui.setWidget(
        WIDGET_KEY,
        (_tui, theme) => ({
            render(width: number): string[] {
                const content = theme.fg("dim", text);
                return [truncateToWidth(content, width, "")];
            },
            invalidate(): void {},
        }),
        { placement: "belowEditor" },
    );
}

function registerCompanionCommands(pi: ExtensionAPI): void {
    pi.registerCommand("typed-commands", {
        description: "List typed slash commands registered through pi-command-args",
        handler: async (_args, ctx) => {
            const commands = getEnabledTypedCommands();
            if (commands.length === 0) {
                ctx.ui.notify("No typed commands are registered.", "info");
                return;
            }

            const items = commands.map((command) => `/${command.name} — ${command.description}`);
            const selected = await ctx.ui.select("Typed commands", items);
            if (selected === undefined) {
                return;
            }

            const name = selected.split(" ", 1)[0]?.slice(1);
            if (name === undefined) {
                return;
            }

            const command = getTypedCommand(name);
            if (command === undefined) {
                return;
            }

            ctx.ui.notify(formatDetailedHelp(command), "info");
        },
    });
}

export function installTypedCommandUx(pi: ExtensionAPI, options?: TypedCommandUxOptions): void {
    const resolvedOptions = options ?? {};
    if (!isToggleEnabled(resolvedOptions.enabled)) {
        return;
    }
    if (resolvedOptions.registerListCommand !== false) {
        registerCompanionCommands(pi);
    }

    let cleanup: Array<() => void> = [];
    let refreshTimer: NodeJS.Timeout | undefined;

    function clearRefreshTimer(): void {
        if (refreshTimer === undefined) {
            return;
        }
        clearTimeout(refreshTimer);
        refreshTimer = undefined;
    }

    function runCleanup(): void {
        clearRefreshTimer();
        for (const callback of cleanup) {
            callback();
        }
        cleanup = [];
    }

    pi.on("session_start", async (_event, ctx) => {
        runCleanup();
        if (!ctx.hasUI) {
            return;
        }

        const refresh = (): void => {
            const helperLine = helperLineForEditorText(ctx.ui.getEditorText());
            setHelperWidget(ctx, helperLine);
        };

        const scheduleRefresh = (): void => {
            clearRefreshTimer();
            refreshTimer = setTimeout(refresh, 0);
        };

        const unsubscribeTerminalInput = ctx.ui.onTerminalInput(() => {
            scheduleRefresh();
            return undefined;
        });
        cleanup.push(unsubscribeTerminalInput);
        cleanup.push(onTypedCommandsChanged(refresh));

        ctx.ui.addAutocompleteProvider((current) => ({
            async getSuggestions(lines, cursorLine, cursorCol, options) {
                const suggestions = getTypedAutocompleteSuggestions(lines, cursorLine, cursorCol);
                if (suggestions !== undefined) {
                    return suggestions;
                }
                return current.getSuggestions(lines, cursorLine, cursorCol, options);
            },
            applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
                return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
            },
            shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
                return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
            },
        }));

        refresh();
    });

    pi.on("input", (_event, ctx) => {
        clearRefreshTimer();
        if (ctx.hasUI) {
            ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
        }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        runCleanup();
        if (ctx.hasUI) {
            ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
        }
    });
}

function environmentDisablesUx(): boolean {
    const value = process.env.PI_COMMAND_ARGS_UX?.toLowerCase();
    if (value === undefined) {
        return false;
    }
    return ["0", "false", "no", "off"].includes(value);
}

export default function piCommandArgsExtension(pi: ExtensionAPI): void {
    if (environmentDisablesUx()) {
        return;
    }
    installTypedCommandUx(pi);
}
