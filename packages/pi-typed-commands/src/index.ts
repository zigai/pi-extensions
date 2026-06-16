import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { getTypedArgumentCompletions, getTypedAutocompleteSuggestions } from "./completions.js";
import { hasIssuesOfKind, parseTypedCommandArgs } from "./parser.js";
import {
    getTypedCommand,
    getTypedSkillDiagnostics,
    isToggleEnabled,
    isTypedCommandEnabled,
    onTypedCommandsChanged,
    registerTypedCommandMetadata,
    replaceTypedSkillMetadata,
} from "./registry.js";
import { getPiTypedCommandsSettings } from "./settings.js";
import type {
    ArgumentDefinitions,
    InferArguments,
    RegisteredTypedCommand,
    TypedCommandFormSymbols,
    TypedCommandOptions,
    TypedCommandToggle,
    FormMode,
} from "./types.js";
import { formatDetailedHelp, formatHelperLineParts } from "./usage.js";
import { openArgumentForm } from "./form.js";
import {
    formatTypedSkillDiagnostics,
    isTypedSkillCommand,
    readTypedSkillMetadataResult,
    renderTypedSkillInvocation,
    skillPathFromCommand,
    typedSkillCommandFromMetadata,
} from "./skills.js";

const WIDGET_KEY = "pi-typed-commands.helper";

type EditorTypedCommandInvocation = {
    command: RegisteredTypedCommand;
    rawArgs: string;
};

type SkillParseResult = {
    parsed: ReturnType<typeof parseTypedCommandArgs>;
    additionalInput: string;
};

const DEFAULT_FORM_SYMBOLS: Required<TypedCommandFormSymbols> = {
    selectedCheckbox: "■",
    unselectedCheckbox: "□",
    selectedRadio: "●",
    unselectedRadio: "○",
};

/** Options for installing the live typed-args editor helper. */
export type TypedCommandUxOptions = {
    /** Enable or disable the live helper and Tab-to-form UX. Defaults to enabled. */
    enabled?: TypedCommandToggle;
};

export type {
    ArgumentDefinition,
    ArgumentDefinitions,
    ArgumentValue,
    ArgumentUi,
    ArgumentWidget,
    ArgumentWidgetInputContext,
    ArgumentWidgetRenderContext,
    ArgumentWidgetTheme,
    CustomArgumentWidget,
    BooleanArgumentDefinition,
    EnumArgumentDefinition,
    InferArguments,
    MultiEnumArgumentDefinition,
    NumberArgumentDefinition,
    ParsedCommandArguments,
    ParseIssue,
    ParseIssueKind,
    PrimitiveArgumentValue,
    RegisteredTypedCommand,
    StringArgumentDefinition,
    RawCommandHandler,
    TypedCommandHandler,
    TypedCommandFormSymbols,
    TypedCommandOptions,
    TypedCommandRawSelector,
    TypedCommandToggle,
    TypedCommandFormTitle,
    FormMode,
} from "./types.js";

export { formatCommandUsage, formatDetailedHelp, formatHelperLine } from "./usage.js";
export { getTypedCommand, getTypedCommands } from "./registry.js";
export { parseTypedCommandArgs } from "./parser.js";
export { getPiTypedCommandsSettings } from "./settings.js";
export {
    normalizeSkillArguments,
    parseSkillMarkdown,
    renderTypedSkillInvocation,
} from "./skills.js";

function notifyIssues(ctx: ExtensionCommandContext, messages: string[]): void {
    if (messages.length === 0) {
        return;
    }
    ctx.ui.notify(messages.join("\n"), "error");
}

function shouldOpenForm<TDefinitions extends ArgumentDefinitions>(
    command: RegisteredTypedCommand<TDefinitions>,
    parsedIssues: string[],
): boolean {
    if (parsedIssues.length === 0) {
        return false;
    }
    return command.openFormWhenInvalid;
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
    const formMode: FormMode = "missing";

    let openForm = shouldOpenForm(command, issueMessages);
    const hasMissingRequired = hasIssuesOfKind(parsed, ["missing-required"]);
    if (hasMissingRequired && command.openFormWhenMissingRequired) {
        openForm = true;
    }
    const hasStructuralIssues = parsed.issues.some((item) => item.name === undefined);
    if (hasStructuralIssues) {
        openForm = false;
    }

    if (openForm) {
        if (!ctx.hasUI) {
            notifyIssues(ctx, issueMessages);
            return undefined;
        }
        const collected = await openArgumentForm(command, parsed, formMode, ctx);
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

/**
 * Register a Pi slash command with typed named arguments.
 *
 * The command is still registered with Pi's raw command system, but pi-typed-commands parses,
 * validates, defaults, completes, and optionally prompts for arguments before calling `handler`.
 */
export function registerTypedCommand<TDefinitions extends ArgumentDefinitions>(
    pi: ExtensionAPI,
    name: string,
    options: TypedCommandOptions<TDefinitions>,
): void {
    const openFormWhenInvalid = options.openFormWhenInvalid ?? true;
    const openFormWhenMissingRequired = options.openFormWhenMissingRequired ?? true;
    const formTitle = options.formTitle;

    const command: RegisteredTypedCommand<TDefinitions> = {
        name,
        description: options.description,
        args: options.args,
        handler: options.handler,
        typedArgsEnabled: options.typedArgsEnabled ?? true,
        formSymbols: { ...DEFAULT_FORM_SYMBOLS, ...options.formSymbols },
        openFormWhenInvalid,
        openFormWhenMissingRequired,
    };

    if (formTitle !== undefined) {
        command.formTitle = formTitle;
    }
    if (options.fallbackHandler !== undefined) {
        command.fallbackHandler = options.fallbackHandler;
    }
    if (options.shouldUseTypedArgs !== undefined) {
        command.shouldUseTypedArgs = options.shouldUseTypedArgs;
    }

    registerTypedCommandMetadata(command);

    pi.registerCommand(name, {
        description: options.description,
        getArgumentCompletions(argumentPrefix) {
            return getTypedArgumentCompletions(command, argumentPrefix);
        },
        handler: async (rawArgs, ctx) => {
            if (!isTypedCommandEnabled(command, ctx, ctx.cwd)) {
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

            if (
                command.shouldUseTypedArgs !== undefined &&
                !command.shouldUseTypedArgs(rawArgs, ctx)
            ) {
                if (command.fallbackHandler !== undefined) {
                    await command.fallbackHandler(rawArgs, ctx);
                    return;
                }
            }

            const args = await resolveCommandArguments(command, rawArgs, ctx);
            if (args === undefined) {
                return;
            }
            await command.handler(args, ctx);
        },
    });
}

function slashCommandMatch(editorText: string): RegExpExecArray | undefined {
    const firstLine = editorText.split("\n", 1)[0];
    if (firstLine === undefined) {
        return undefined;
    }

    return /^\/(\S+)(?:\s+(.*))?$/.exec(firstLine) ?? undefined;
}

function commandInvocationForEditorText(
    editorText: string,
    cwd: string,
    ctx?: ExtensionContext,
): EditorTypedCommandInvocation | undefined {
    const match = slashCommandMatch(editorText);
    if (match === undefined) {
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
    if (!isTypedCommandEnabled(command, ctx, cwd)) {
        return undefined;
    }

    return {
        command,
        rawArgs: match[2] ?? "",
    };
}

function notifySkillDiagnosticsForText(text: string, ctx: ExtensionCommandContext): boolean {
    const match = slashCommandMatch(text);
    const commandName = match?.[1];
    if (commandName === undefined) {
        return false;
    }
    const diagnostics = getTypedSkillDiagnostics(commandName);
    if (diagnostics === undefined) {
        return false;
    }
    ctx.ui.notify(formatTypedSkillDiagnostics(diagnostics), "error");
    return true;
}

function helperCommandForEditorText(
    editorText: string,
    cwd: string,
    ctx?: ExtensionContext,
): RegisteredTypedCommand | undefined {
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

    const invocation = commandInvocationForEditorText(editorText, cwd, ctx);
    if (invocation === undefined) {
        return undefined;
    }

    const { command } = invocation;

    if (Object.keys(command.args).length === 0) {
        return undefined;
    }

    return command;
}

function parseSkillArguments(command: RegisteredTypedCommand, rawArgs: string): SkillParseResult {
    const parsed = parseTypedCommandArgs(command, rawArgs);
    const additionalTokens: string[] = [];
    parsed.issues = parsed.issues.filter((issue) => {
        if (issue.kind !== "unexpected-positional") {
            return true;
        }
        if (issue.token !== undefined) {
            additionalTokens.push(issue.token);
        }
        return false;
    });
    return {
        parsed,
        additionalInput: additionalTokens.join(" "),
    };
}

async function renderTypedSkillInput(
    command: RegisteredTypedCommand,
    rawArgs: string,
    ctx: ExtensionCommandContext,
    formMode: FormMode,
): Promise<string | undefined> {
    if (!isTypedSkillCommand(command)) {
        return undefined;
    }

    const { parsed, additionalInput } = parseSkillArguments(command, rawArgs);
    if (parsed.mode === "help") {
        ctx.ui.notify(formatDetailedHelp(command), "info");
        return undefined;
    }

    const issueMessages = parsed.issues.map((item) => item.message);
    let values = parsed.values;

    let openForm = shouldOpenForm(command, issueMessages);
    const hasMissingRequired = hasIssuesOfKind(parsed, ["missing-required"]);
    if (hasMissingRequired && command.openFormWhenMissingRequired) {
        openForm = true;
    }

    if (openForm) {
        if (!ctx.hasUI) {
            notifyIssues(ctx, issueMessages);
            return undefined;
        }
        const collected = await openArgumentForm(command, parsed, formMode, ctx);
        if (collected === undefined) {
            return undefined;
        }
        values = collected;
    } else if (issueMessages.length > 0) {
        notifyIssues(ctx, issueMessages);
        return undefined;
    }

    return renderTypedSkillInvocation({
        skill: command.skill,
        values,
        additionalInput,
    });
}

async function transformTypedSkillInput(
    text: string,
    ctx: ExtensionCommandContext,
    formMode: FormMode = "missing",
): Promise<string | undefined> {
    const invocation = commandInvocationForEditorText(text, ctx.cwd, ctx);
    if (invocation === undefined || !isTypedSkillCommand(invocation.command)) {
        return undefined;
    }
    return renderTypedSkillInput(invocation.command, invocation.rawArgs, ctx, formMode);
}

async function openEditorCommandForm(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
    const invocation = commandInvocationForEditorText(ctx.ui.getEditorText(), ctx.cwd, ctx);
    if (invocation === undefined) {
        return;
    }

    const { command, rawArgs } = invocation;
    const commandCtx = ctx as ExtensionCommandContext;

    if (isTypedSkillCommand(command)) {
        const transformed = await renderTypedSkillInput(command, rawArgs, commandCtx, "all");
        if (transformed === undefined) {
            return;
        }
        ctx.ui.setEditorText("");
        pi.sendUserMessage(transformed);
        return;
    }

    if (command.shouldUseTypedArgs !== undefined) {
        if (!command.shouldUseTypedArgs(rawArgs, commandCtx)) {
            if (command.fallbackHandler !== undefined) {
                ctx.ui.setEditorText("");
                await command.fallbackHandler(rawArgs, commandCtx);
            }
            return;
        }
    }

    const parsed = parseTypedCommandArgs(command, rawArgs);
    if (parsed.mode === "help") {
        ctx.ui.notify(formatDetailedHelp(command), "info");
        return;
    }

    const args = await openArgumentForm(command, parsed, "all", commandCtx);
    if (args === undefined) {
        return;
    }

    ctx.ui.setEditorText("");
    await command.handler(args as never, commandCtx);
}

function refreshTypedSkills(pi: ExtensionAPI): void {
    const commands: RegisteredTypedCommand[] = [];
    const diagnostics = [];
    for (const command of pi.getCommands()) {
        const skillPath = skillPathFromCommand(command);
        if (skillPath === undefined) {
            continue;
        }
        try {
            const result = readTypedSkillMetadataResult(skillPath);
            if (result.metadata !== undefined) {
                commands.push(typedSkillCommandFromMetadata(result.metadata));
            }
            if (result.diagnostics !== undefined) {
                diagnostics.push(result.diagnostics);
            }
        } catch (error) {
            let message = String(error);
            if (error instanceof Error) {
                message = error.message;
            }
            diagnostics.push({
                name: command.name.replace(/^skill:/, ""),
                filePath: skillPath,
                messages: [`failed to read typed arguments: ${message}`],
            });
        }
    }
    replaceTypedSkillMetadata(commands, diagnostics);
}

function setHelperWidget(ctx: ExtensionContext, command: RegisteredTypedCommand | undefined): void {
    if (command === undefined) {
        ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
        return;
    }

    ctx.ui.setWidget(
        WIDGET_KEY,
        (_tui, theme) => ({
            render(width: number): string[] {
                const content = formatHelperLineParts(command, {
                    showTypes: getPiTypedCommandsSettings(ctx.cwd).uxShowTypes,
                })
                    .map((part) => {
                        if (part.kind === "command") {
                            return theme.fg("accent", part.text);
                        }
                        if (part.kind === "positional") {
                            return theme.fg("warning", part.text);
                        }
                        if (part.kind === "flag") {
                            return theme.fg("success", part.text);
                        }
                        if (part.kind === "detail") {
                            return theme.fg("muted", part.text);
                        }
                        return theme.fg("dim", part.text);
                    })
                    .join("");
                return [truncateToWidth(content, width, "")];
            },
            invalidate(): void {},
        }),
        { placement: "belowEditor" },
    );
}

class TypedCommandUxSession {
    private cleanup: Array<() => void> = [];
    private refreshTimer: NodeJS.Timeout | undefined;
    private openingForm = false;

    constructor(private readonly pi: ExtensionAPI) {}

    start(ctx: ExtensionContext): void {
        this.stop();
        if (!ctx.hasUI) {
            return;
        }
        if (!getPiTypedCommandsSettings(ctx.cwd).uxEnabled) {
            return;
        }

        const refresh = (): void => {
            this.refresh(ctx);
        };

        this.cleanup.push(ctx.ui.onTerminalInput((data) => this.handleTerminalInput(data, ctx)));
        this.cleanup.push(onTypedCommandsChanged(refresh));
        this.addAutocompleteProvider(ctx);
        refresh();
    }

    clearWidget(ctx: ExtensionContext): void {
        this.clearRefreshTimer();
        if (ctx.hasUI) {
            ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
        }
    }

    stop(): void {
        this.clearRefreshTimer();
        for (const callback of this.cleanup) {
            callback();
        }
        this.cleanup = [];
        this.openingForm = false;
    }

    private clearRefreshTimer(): void {
        if (this.refreshTimer === undefined) {
            return;
        }
        clearTimeout(this.refreshTimer);
        this.refreshTimer = undefined;
    }

    private refresh(ctx: ExtensionContext): void {
        if (this.openingForm) {
            setHelperWidget(ctx, undefined);
            return;
        }
        const helperCommand = helperCommandForEditorText(ctx.ui.getEditorText(), ctx.cwd, ctx);
        setHelperWidget(ctx, helperCommand);
    }

    private scheduleRefresh(ctx: ExtensionContext): void {
        this.clearRefreshTimer();
        this.refreshTimer = setTimeout(() => {
            this.refresh(ctx);
        }, 0);
    }

    private handleTerminalInput(
        data: string,
        ctx: ExtensionContext,
    ): { consume: true } | undefined {
        if (this.openingForm) {
            setHelperWidget(ctx, undefined);
            return undefined;
        }
        if (!matchesKey(data, "tab")) {
            this.scheduleRefresh(ctx);
            return undefined;
        }
        if (commandInvocationForEditorText(ctx.ui.getEditorText(), ctx.cwd, ctx) === undefined) {
            this.scheduleRefresh(ctx);
            return undefined;
        }

        this.openingForm = true;
        this.clearWidget(ctx);
        void openEditorCommandForm(this.pi, ctx).finally(() => {
            this.openingForm = false;
            this.scheduleRefresh(ctx);
        });
        return { consume: true };
    }

    private addAutocompleteProvider(ctx: ExtensionContext): void {
        ctx.ui.addAutocompleteProvider((current) => ({
            async getSuggestions(lines, cursorLine, cursorCol, options) {
                const suggestions = getTypedAutocompleteSuggestions(
                    lines,
                    cursorLine,
                    cursorCol,
                    ctx.cwd,
                    ctx,
                );
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
    }
}

/**
 * Install the live editor helper, typed autocomplete bridge, and Tab-to-form shortcut.
 *
 * This is installed automatically by the default extension export. Extension authors usually only
 * call it directly when composing pi-typed-commands into a custom extension entrypoint.
 */
export function installTypedCommandUx(pi: ExtensionAPI, options?: TypedCommandUxOptions): void {
    const resolvedOptions = options ?? {};
    if (!isToggleEnabled(resolvedOptions.enabled)) {
        return;
    }

    const session = new TypedCommandUxSession(pi);

    pi.on("session_start", async (_event, ctx) => {
        refreshTypedSkills(pi);
        session.start(ctx);
    });

    pi.on("input", async (event, ctx) => {
        session.clearWidget(ctx);
        const commandCtx = ctx as ExtensionCommandContext;
        if (notifySkillDiagnosticsForText(event.text, commandCtx)) {
            return { action: "handled" } as const;
        }
        const transformed = await transformTypedSkillInput(event.text, commandCtx);
        if (transformed !== undefined) {
            if (event.images !== undefined) {
                return { action: "transform", text: transformed, images: event.images } as const;
            }
            return { action: "transform", text: transformed } as const;
        }
        return { action: "continue" } as const;
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        session.stop();
        session.clearWidget(ctx);
    });
}

function installWidgetShowcaseCommand(pi: ExtensionAPI): void {
    registerTypedCommand(pi, "typed-commands-demo", {
        description: "Showcase every pi-typed-commands dense-form widget",
        formTitle: "Typed Commands Demo",
        args: {
            text: {
                type: "string",
                default: "hello",
                description: "Single-line text input",
                ui: { widget: "text" },
            },
            textarea: {
                type: "string",
                default: "Write a longer note here.",
                description: "Multiline text editor",
                ui: { widget: "textarea", rows: 4 },
            },
            count: {
                type: "number",
                integer: true,
                min: 1,
                max: 10,
                default: 3,
                description: "Number input with validation",
                ui: { widget: "number" },
            },
            enabled: {
                type: "boolean",
                default: true,
                description: "Boolean toggle",
                ui: { widget: "toggle" },
            },
            environment: {
                type: "enum",
                values: ["dev", "staging", "prod"] as const,
                default: "dev",
                description: "Enum select",
                ui: { widget: "select" },
            },
            flavor: {
                type: "enum",
                values: ["vanilla", "chocolate", "strawberry"] as const,
                default: "vanilla",
                description: "Radio-style enum",
                ui: { widget: "radio" },
            },
            tags: {
                type: "multi-enum",
                values: ["api", "web", "worker", "docs"] as const,
                default: ["api"],
                description: "Multi-select enum",
                ui: { widget: "multiselect" },
            },
            path: {
                type: "string",
                default: "./README.md",
                description: "Path input",
                ui: { widget: "path" },
            },
            command: {
                type: "string",
                default: "npm test",
                description: "Command textarea",
                ui: { widget: "command", rows: 3 },
            },
            readonly: {
                type: "string",
                default: "This field is shown but not editable.",
                description: "Read-only value",
                ui: { widget: "readonly" },
            },
            computed: {
                type: "string",
                default: "Computed preview placeholder",
                description: "Computed display value",
                ui: { widget: "computed" },
            },
            confirm: {
                type: "boolean",
                default: false,
                description: "Explicit confirmation",
                ui: { widget: "confirm" },
            },
        },
        handler: async (args, ctx) => {
            ctx.ui.notify(JSON.stringify(args, null, 2), "info");
        },
    });
}

/** Pi extension entrypoint that installs the demo command and typed-args UX. */
export default function piTypedCommandsExtension(pi: ExtensionAPI): void {
    installWidgetShowcaseCommand(pi);
    installTypedCommandUx(pi);
}
