import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
    expandGroupedArgumentValues,
    flattenGroupedArgumentDefinitions,
    flattenGroupedArgumentValues,
    hasArgumentGroups,
} from "./arguments.js";
import { getTypedArgumentCompletions, getTypedAutocompleteSuggestions } from "./completions.js";
import { cloneAndFreezeDefinitions, compileTypedCommandDefinition } from "./compiler.js";
import { parseTypedCommandArgs, serializeTypedCommandArgs, toTypedParseResult } from "./parser.js";
import {
    combineSkillAdditionalInput,
    decideArgumentIssueAction,
    decideTypedCommandPreflight,
    parseSlashCommandText,
} from "./invocation.js";
import {
    getTypedCommand,
    getTypedSkillDiagnostics,
    isToggleEnabled,
    isTypedCommandEnabled,
    onTypedCommandsChanged,
    registerTypedCommandMetadata,
    replaceTypedSkillMetadata,
    unregisterTypedCommandMetadata,
} from "./registry.js";
import { getPiTypedCommandsSettings } from "./settings.js";
import type {
    ArgumentDefinitions,
    ArgumentValue,
    DefinedTypedCommand,
    InferArguments,
    ParsedCommandArguments,
    RegisteredTypedCommand,
    TypedCommandDefinition,
    TypedCommandHandler,
    TypedCommandFormSymbols,
    TypedCommandHandle,
    TypedCommandOptions,
    TypedCommandRefinement,
    TypedCommandToggle,
    TypedParseResult,
    FormMode,
} from "./types.js";
import { formatCommandUsage, formatDetailedHelp, formatHelperLineParts } from "./usage.js";
import { openArgumentForm } from "./form.js";
import {
    formatTypedSkillDiagnostics,
    isTypedSkillCommand,
    readTypedSkillMetadataResult,
    renderTypedSkillInvocation,
    skillPathFromCommand,
    typedSkillCommandFromMetadata,
    type SkillArgumentDiagnostic,
    type TypedSkillDiagnostics,
} from "./skills.js";

const WIDGET_KEY = "pi-typed-commands.helper";

type EditorTypedCommandInvocation = {
    command: RegisteredTypedCommand;
    rawArgs: string;
    trailingBody: string;
};

type SkillParseResult = {
    parsed: ReturnType<typeof parseTypedCommandArgs>;
    additionalInput: string;
};

type TypedSkillInputResult = { action: "handled" } | { action: "transform"; text: string };

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
    ArgumentOccurrencePolicy,
    ArgumentValue,
    ArgumentUi,
    ArgumentWidget,
    ArgumentWidgetInputContext,
    ArgumentWidgetRenderContext,
    ArgumentWidgetTheme,
    CustomArgumentWidget,
    BooleanArgumentDefinition,
    ArgumentDescription,
    ArgumentGroupDefinition,
    CompileResult,
    CompiledArgument,
    CompiledCommand,
    DecodeResult,
    DefinedTypedCommand,
    DefinitionDiagnostic,
    FieldEditor,
    EnumArgumentDefinition,
    InferArguments,
    InvocationTarget,
    MaybePromise,
    MultiEnumArgumentDefinition,
    NumberArgumentDefinition,
    ParsedCommandArguments,
    ParseIssue,
    ParseIssueKind,
    RawArgumentOccurrence,
    PrimitiveArgumentValue,
    RegisteredTypedCommand,
    StringArgumentDefinition,
    RawCommandHandler,
    TypedCommandDefinition,
    TypedCommandHandler,
    TypedCommandHandle,
    TypedCommandOptions,
    TypedCommandRawSelector,
    TypedCompletionContext,
    TypedCompletionItem,
    TypedCompletionProvider,
    TypedCompletionReplacementRange,
    TypedCommandRefinement,
    TypedCommandRefinementContext,
    TypedCommandRefinementIssue,
    TypedCommandToggle,
    TypedCommandFormSymbols,
    TypedCommandFormTitle,
    TypedParseResult,
    FormMode,
} from "./types.js";

export {
    booleanArgument,
    enumArgument,
    expandGroupedArgumentValues,
    flattenGroupedArgumentDefinitions,
    flattenGroupedArgumentValues,
    group,
    hasArgumentGroups,
    isArgumentGroupDefinition,
    multiEnumArgument,
    numberArgument,
    stringArgument,
} from "./arguments.js";
export { compileTypedCommandDefinition } from "./compiler.js";
export { formatCommandUsage, formatDetailedHelp, formatHelperLine } from "./usage.js";
export { getTypedCommand, getTypedCommands } from "./registry.js";
export {
    lexTypedArgumentString,
    parseTypedCommandArgs,
    serializeTypedCommandArgs,
    toTypedParseResult,
} from "./parser.js";
export { getPiTypedCommandsSettings } from "./settings.js";
export {
    normalizeSkillArguments,
    parseSkillMarkdown,
    renderTypedSkillInvocation,
} from "./skills.js";
export type {
    RawSkillArgumentDefinition,
    RawSkillArguments,
    ReadTypedSkillMetadataResult,
    RenderTypedSkillInvocationOptions,
    SkillArgumentDiagnostic,
    SkillArgumentNormalizationResult,
    SkillFrontmatter,
    TypedSkillDiagnostics,
    TypedSkillMetadata,
} from "./skills.js";

function notifyIssues(ctx: ExtensionCommandContext, messages: string[]): void {
    if (messages.length === 0) {
        return;
    }
    ctx.ui.notify(messages.join("\n"), "error");
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
    const issueAction = decideArgumentIssueAction(
        {
            openFormWhenInvalid: command.openFormWhenInvalid,
            openFormWhenMissingRequired: command.openFormWhenMissingRequired,
        },
        parsed.issues,
    );

    if (issueAction === "open-form") {
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

    if (issueAction === "notify") {
        notifyIssues(ctx, issueMessages);
        return undefined;
    }

    return parsed.values as InferArguments<TDefinitions>;
}

function definitionError(name: string, diagnostics: readonly string[]): Error {
    return new Error([`Invalid typed arguments for /${name}:`, ...diagnostics].join("\n"));
}

function maybeExpandGroupedValues<TDefinitions extends ArgumentDefinitions>(
    values: Readonly<Record<string, ArgumentValue>>,
    definitions: TDefinitions,
): Record<string, unknown> {
    if (!hasArgumentGroups(definitions)) {
        return { ...values };
    }
    return expandGroupedArgumentValues(values, definitions);
}

function maybeFlattenGroupedValues<TDefinitions extends ArgumentDefinitions>(
    values: Readonly<Record<string, unknown>>,
    definitions: TDefinitions,
): Record<string, ArgumentValue> {
    if (!hasArgumentGroups(definitions)) {
        return { ...(values as Record<string, ArgumentValue>) };
    }
    return flattenGroupedArgumentValues(values, definitions);
}

function maybeWrapGroupedRefinement<TDefinitions extends ArgumentDefinitions>(
    definitions: TDefinitions,
    refine: TypedCommandRefinement<TDefinitions> | undefined,
): TypedCommandRefinement<TDefinitions> | undefined {
    if (refine === undefined || !hasArgumentGroups(definitions)) {
        return refine;
    }
    return (args, context) => refine(maybeExpandGroupedValues(args, definitions) as never, context);
}

function maybeWrapGroupedHandler<TDefinitions extends ArgumentDefinitions>(
    definitions: TDefinitions,
    handler: TypedCommandHandler<TDefinitions>,
): TypedCommandHandler<TDefinitions> {
    if (!hasArgumentGroups(definitions)) {
        return handler;
    }
    return (args, ctx) => handler(maybeExpandGroupedValues(args, definitions) as never, ctx);
}

function typedParseResultForDefinition<TDefinitions extends ArgumentDefinitions>(
    parsed: ParsedCommandArguments,
    definitions: TDefinitions,
): TypedParseResult<TDefinitions> {
    const result = toTypedParseResult<TDefinitions>(parsed);
    if (!hasArgumentGroups(definitions)) {
        return result;
    }
    if (result.status === "success") {
        return {
            ...result,
            value: maybeExpandGroupedValues(
                result.value,
                definitions,
            ) as InferArguments<TDefinitions>,
        };
    }
    if (result.status === "error") {
        return {
            ...result,
            partial: maybeExpandGroupedValues(result.partial, definitions) as Partial<
                InferArguments<TDefinitions>
            >,
        };
    }
    return result;
}

function registeredCommandForDefinition<TDefinitions extends ArgumentDefinitions>(
    definition: Pick<
        TypedCommandDefinition<TDefinitions>,
        "name" | "description" | "args" | "refine"
    >,
): RegisteredTypedCommand<TDefinitions> {
    const compiled = compileTypedCommandDefinition(definition);
    if (!compiled.ok) {
        throw definitionError(
            definition.name,
            compiled.diagnostics.map((diagnostic) => diagnostic.message),
        );
    }
    const command: RegisteredTypedCommand<TDefinitions> = {
        name: definition.name,
        description: definition.description,
        args: compiled.command.args as TDefinitions,
        compiled: compiled.command,
        target: { kind: "extension", run: () => {} },
        typedArgsEnabled: true,
        formSymbols: DEFAULT_FORM_SYMBOLS,
        openFormWhenInvalid: true,
        openFormWhenMissingRequired: true,
    };
    const refine = maybeWrapGroupedRefinement(definition.args, definition.refine);
    if (refine !== undefined) {
        command.refine = refine;
    }
    return command;
}

/** Define a typed command once, preserving literal argument inference and exposing pure helpers. */
export function defineTypedCommand<const TDefinitions extends ArgumentDefinitions>(
    definition: TypedCommandDefinition<TDefinitions>,
): DefinedTypedCommand<TDefinitions> {
    const compiled = compileTypedCommandDefinition(definition);
    if (!compiled.ok) {
        throw definitionError(
            definition.name,
            compiled.diagnostics.map((diagnostic) => diagnostic.message),
        );
    }

    const normalizedDefinition = {
        ...definition,
        args: cloneAndFreezeDefinitions(definition.args) as TDefinitions,
    } as TypedCommandDefinition<TDefinitions>;
    const command = registeredCommandForDefinition(normalizedDefinition);
    const defined = {
        ...normalizedDefinition,
        parse(rawArgs: string) {
            return typedParseResultForDefinition(
                parseTypedCommandArgs(command, rawArgs),
                normalizedDefinition.args,
            );
        },
        serialize(values: Partial<InferArguments<TDefinitions>>) {
            return serializeTypedCommandArgs(
                command,
                maybeFlattenGroupedValues(
                    values as Record<string, unknown>,
                    normalizedDefinition.args,
                ),
            );
        },
        formatUsage() {
            return formatCommandUsage(command);
        },
        formatHelp() {
            return formatDetailedHelp(command);
        },
    };
    return Object.freeze(defined) as DefinedTypedCommand<TDefinitions>;
}

function normalizeRegisteredCommand<TDefinitions extends ArgumentDefinitions>(
    name: string,
    options: TypedCommandOptions<TDefinitions>,
): RegisteredTypedCommand<TDefinitions> {
    const runtimeArgs = flattenGroupedArgumentDefinitions(options.args) as TDefinitions;
    const compiled = compileTypedCommandDefinition({
        name,
        description: options.description,
        args: runtimeArgs,
    });
    if (!compiled.ok) {
        throw definitionError(
            name,
            compiled.diagnostics.map((diagnostic) => diagnostic.message),
        );
    }

    const command: RegisteredTypedCommand<TDefinitions> = {
        name,
        description: options.description,
        args: compiled.command.args as TDefinitions,
        compiled: compiled.command,
        handler: maybeWrapGroupedHandler(options.args, options.handler),
        target: { kind: "extension", run: maybeWrapGroupedHandler(options.args, options.handler) },
        typedArgsEnabled: options.typedArgsEnabled ?? true,
        formSymbols: { ...DEFAULT_FORM_SYMBOLS, ...options.formSymbols },
        openFormWhenInvalid: options.openFormWhenInvalid ?? true,
        openFormWhenMissingRequired: options.openFormWhenMissingRequired ?? true,
        source: "extension",
    };

    const refine = maybeWrapGroupedRefinement(options.args, options.refine);
    if (refine !== undefined) {
        command.refine = refine;
    }
    if (options.formTitle !== undefined) {
        command.formTitle = options.formTitle;
    }
    if (options.fallbackHandler !== undefined) {
        command.fallbackHandler = options.fallbackHandler;
    }
    if (options.shouldUseTypedArgs !== undefined) {
        command.shouldUseTypedArgs = options.shouldUseTypedArgs;
    }
    return command;
}

function commandOptionsFromDefinition<TDefinitions extends ArgumentDefinitions>(
    definition: TypedCommandDefinition<TDefinitions>,
): TypedCommandOptions<TDefinitions> {
    const handler = definition.handler ?? definition.run;
    if (handler === undefined) {
        throw new Error(`Typed command /${definition.name} must define a handler or run function`);
    }
    const options: TypedCommandOptions<TDefinitions> = {
        description: definition.description,
        args: definition.args,
        handler,
    };
    if (definition.refine !== undefined) {
        options.refine = definition.refine;
    }
    if (definition.fallbackHandler !== undefined) {
        options.fallbackHandler = definition.fallbackHandler;
    }
    if (definition.typedArgsEnabled !== undefined) {
        options.typedArgsEnabled = definition.typedArgsEnabled;
    }
    if (definition.shouldUseTypedArgs !== undefined) {
        options.shouldUseTypedArgs = definition.shouldUseTypedArgs;
    }
    if (definition.formTitle !== undefined) {
        options.formTitle = definition.formTitle;
    }
    if (definition.formSymbols !== undefined) {
        options.formSymbols = definition.formSymbols;
    }
    if (definition.openFormWhenInvalid !== undefined) {
        options.openFormWhenInvalid = definition.openFormWhenInvalid;
    }
    if (definition.openFormWhenMissingRequired !== undefined) {
        options.openFormWhenMissingRequired = definition.openFormWhenMissingRequired;
    }
    return options;
}

function createCommandHandle<TDefinitions extends ArgumentDefinitions>(
    definition: DefinedTypedCommand<TDefinitions>,
    command: RegisteredTypedCommand<TDefinitions>,
    invocationName: string,
): TypedCommandHandle<TDefinitions> {
    let disposed = false;
    return Object.freeze({
        definition,
        invocationName,
        parse(rawArgs: string) {
            return definition.parse(rawArgs);
        },
        serialize(values: Partial<InferArguments<TDefinitions>>) {
            return definition.serialize(values);
        },
        formatUsage() {
            return definition.formatUsage();
        },
        formatHelp() {
            return definition.formatHelp();
        },
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            unregisterTypedCommandMetadata(command);
        },
    });
}

export function registerTypedCommand<const TDefinitions extends ArgumentDefinitions>(
    pi: ExtensionAPI,
    definition: TypedCommandDefinition<TDefinitions> | DefinedTypedCommand<TDefinitions>,
): TypedCommandHandle<TDefinitions>;
export function registerTypedCommand<const TDefinitions extends ArgumentDefinitions>(
    pi: ExtensionAPI,
    name: string,
    options: TypedCommandOptions<TDefinitions>,
): TypedCommandHandle<TDefinitions>;
/**
 * Register a Pi slash command with typed named arguments.
 *
 * The command is still registered with Pi's raw command system, but pi-typed-commands parses,
 * validates, defaults, completes, and optionally prompts for arguments before calling `handler`.
 */
export function registerTypedCommand<TDefinitions extends ArgumentDefinitions>(
    pi: ExtensionAPI,
    nameOrDefinition:
        | string
        | TypedCommandDefinition<TDefinitions>
        | DefinedTypedCommand<TDefinitions>,
    options?: TypedCommandOptions<TDefinitions>,
): TypedCommandHandle<TDefinitions> {
    const definitionMode = typeof nameOrDefinition !== "string";
    let name: string;
    let commandOptions: TypedCommandOptions<TDefinitions> | undefined;
    if (definitionMode) {
        name = nameOrDefinition.name;
        commandOptions = commandOptionsFromDefinition(nameOrDefinition);
    } else {
        name = nameOrDefinition;
        commandOptions = options;
    }
    if (commandOptions === undefined) {
        throw new Error(`Typed command /${name} is missing options`);
    }

    const command = normalizeRegisteredCommand(name, commandOptions);
    const maybeInvocationName = pi.registerCommand(name, {
        description: command.description,
        getArgumentCompletions(argumentPrefix) {
            return getTypedArgumentCompletions(command, argumentPrefix);
        },
        handler: async (rawArgs, ctx) => {
            const typedCommandEnabled = isTypedCommandEnabled(command, ctx, ctx.cwd);
            let shouldUseTypedArgs = true;
            if (typedCommandEnabled && command.shouldUseTypedArgs !== undefined) {
                shouldUseTypedArgs = command.shouldUseTypedArgs(rawArgs, ctx);
            }

            const preflight = decideTypedCommandPreflight({
                typedCommandEnabled,
                shouldUseTypedArgs,
                hasFallback: command.fallbackHandler !== undefined,
            });

            if (preflight.action === "fallback") {
                const fallbackHandler = command.fallbackHandler;
                if (fallbackHandler !== undefined) {
                    await fallbackHandler(rawArgs, ctx);
                }
                return;
            }

            if (preflight.action === "stop") {
                if (preflight.reason === "disabled") {
                    ctx.ui.notify(
                        `Typed args are disabled for /${name}, and no fallback handler is configured.`,
                        "warning",
                    );
                    return;
                }
                ctx.ui.notify(
                    `Typed args were skipped for /${name}, and no fallback handler is configured.`,
                    "warning",
                );
                return;
            }

            const args = await resolveCommandArguments(command, rawArgs, ctx);
            if (args === undefined) {
                return;
            }
            let handler = command.handler;
            if (handler === undefined && command.target?.kind === "extension") {
                handler = command.target.run;
            }
            if (handler === undefined) {
                ctx.ui.notify(
                    `Typed command /${name} does not have an extension handler.`,
                    "error",
                );
                return;
            }
            await handler(args, ctx);
        },
    }) as unknown;

    let piInvocationName: string | undefined;
    if (typeof maybeInvocationName === "string") {
        piInvocationName = maybeInvocationName;
    }
    let invocationName: string;
    if (piInvocationName === undefined) {
        invocationName = registerTypedCommandMetadata(command);
    } else {
        invocationName = registerTypedCommandMetadata(command, {
            invocationName: piInvocationName,
        });
    }
    let definition: DefinedTypedCommand<TDefinitions>;
    if (definitionMode) {
        definition = defineTypedCommand({ ...nameOrDefinition, args: command.args });
    } else {
        definition = defineTypedCommand({ name, ...commandOptions, args: command.args });
    }
    return createCommandHandle(definition, command, invocationName);
}

function slashCommandMatch(editorText: string): ReturnType<typeof parseSlashCommandText> {
    return parseSlashCommandText(editorText);
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

    const command = getTypedCommand(match.commandName);
    if (command === undefined) {
        return undefined;
    }
    if (!isTypedCommandEnabled(command, ctx, cwd)) {
        return undefined;
    }

    return {
        command,
        rawArgs: match.rawArgs,
        trailingBody: match.trailingBody,
    };
}

function notifySkillDiagnosticsForText(text: string, ctx: ExtensionCommandContext): boolean {
    if (!getPiTypedCommandsSettings(ctx.cwd).enabled) {
        return false;
    }

    const match = slashCommandMatch(text);
    if (match === undefined) {
        return false;
    }
    const diagnostics = getTypedSkillDiagnostics(match.commandName);
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
    const match = slashCommandMatch(editorText);
    if (match === undefined) {
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

function parseSkillArguments(
    command: RegisteredTypedCommand,
    rawArgs: string,
    trailingBody: string,
): SkillParseResult {
    const parsed = parseTypedCommandArgs(command, rawArgs);
    const additionalTokens: string[] = [];
    parsed.issues = parsed.issues.filter((issue) => {
        const canPreserveAsAdditionalInput =
            issue.kind === "unexpected-positional" ||
            (issue.kind === "unknown-argument" && issue.name === undefined);
        if (!canPreserveAsAdditionalInput || issue.token === undefined) {
            return true;
        }
        additionalTokens.push(issue.token);
        return false;
    });
    return {
        parsed,
        additionalInput: combineSkillAdditionalInput(additionalTokens.join(" "), trailingBody),
    };
}

async function renderTypedSkillInput(
    command: RegisteredTypedCommand,
    rawArgs: string,
    trailingBody: string,
    ctx: ExtensionCommandContext,
    formMode: FormMode,
): Promise<string | undefined> {
    if (!isTypedSkillCommand(command)) {
        return undefined;
    }

    const { parsed, additionalInput } = parseSkillArguments(command, rawArgs, trailingBody);
    if (parsed.mode === "help") {
        ctx.ui.notify(formatDetailedHelp(command), "info");
        return undefined;
    }

    const issueMessages = parsed.issues.map((item) => item.message);
    let values = parsed.values;
    const issueAction = decideArgumentIssueAction(
        {
            openFormWhenInvalid: command.openFormWhenInvalid,
            openFormWhenMissingRequired: command.openFormWhenMissingRequired,
        },
        parsed.issues,
    );

    if (issueAction === "open-form") {
        if (!ctx.hasUI) {
            notifyIssues(ctx, issueMessages);
            return undefined;
        }
        const collected = await openArgumentForm(command, parsed, formMode, ctx);
        if (collected === undefined) {
            return undefined;
        }
        values = collected;
    } else if (issueAction === "notify") {
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
): Promise<TypedSkillInputResult | undefined> {
    const invocation = commandInvocationForEditorText(text, ctx.cwd, ctx);
    if (invocation === undefined || !isTypedSkillCommand(invocation.command)) {
        return undefined;
    }

    const transformed = await renderTypedSkillInput(
        invocation.command,
        invocation.rawArgs,
        invocation.trailingBody,
        ctx,
        formMode,
    );
    if (transformed === undefined) {
        return { action: "handled" };
    }
    return { action: "transform", text: transformed };
}

async function openEditorCommandForm(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
    const invocation = commandInvocationForEditorText(ctx.ui.getEditorText(), ctx.cwd, ctx);
    if (invocation === undefined) {
        return;
    }

    const { command, rawArgs, trailingBody } = invocation;
    const commandCtx = ctx as ExtensionCommandContext;

    if (isTypedSkillCommand(command)) {
        const transformed = await renderTypedSkillInput(
            command,
            rawArgs,
            trailingBody,
            commandCtx,
            "all",
        );
        if (transformed === undefined) {
            return;
        }
        ctx.ui.setEditorText("");
        pi.sendUserMessage(transformed);
        return;
    }

    let shouldUseTypedArgs = true;
    if (command.shouldUseTypedArgs !== undefined) {
        shouldUseTypedArgs = command.shouldUseTypedArgs(rawArgs, commandCtx);
    }
    const preflight = decideTypedCommandPreflight({
        typedCommandEnabled: true,
        shouldUseTypedArgs,
        hasFallback: command.fallbackHandler !== undefined,
    });
    if (preflight.action === "fallback") {
        const fallbackHandler = command.fallbackHandler;
        if (fallbackHandler !== undefined) {
            ctx.ui.setEditorText("");
            await fallbackHandler(rawArgs, commandCtx);
        }
        return;
    }
    if (preflight.action === "stop") {
        return;
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

    let handler = command.handler;
    if (handler === undefined && command.target?.kind === "extension") {
        handler = command.target.run;
    }
    if (handler === undefined) {
        ctx.ui.notify(
            `Typed command /${command.name} does not have an extension handler.`,
            "error",
        );
        return;
    }

    ctx.ui.setEditorText("");
    await handler(args as never, commandCtx);
}

function refreshTypedSkills(pi: ExtensionAPI): void {
    const commands: RegisteredTypedCommand[] = [];
    const diagnostics: TypedSkillDiagnostics[] = [];
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
            const diagnostic: SkillArgumentDiagnostic = {
                code: "skill.arguments.read_failed",
                message: `failed to read typed arguments: ${message}`,
                path: [],
                severity: "error",
            };
            diagnostics.push({
                name: command.name.replace(/^skill:/, ""),
                filePath: skillPath,
                messages: [diagnostic.message],
                diagnostics: [diagnostic],
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
        const typedSkillResult = await transformTypedSkillInput(event.text, commandCtx);
        if (typedSkillResult?.action === "handled") {
            return { action: "handled" } as const;
        }
        if (typedSkillResult?.action === "transform") {
            if (event.images !== undefined) {
                return {
                    action: "transform",
                    text: typedSkillResult.text,
                    images: event.images,
                } as const;
            }
            return { action: "transform", text: typedSkillResult.text } as const;
        }
        return { action: "continue" } as const;
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        session.stop();
        session.clearWidget(ctx);
    });
}

/** Pi extension entrypoint that installs the typed-args UX. */
export default function piTypedCommandsExtension(pi: ExtensionAPI): void {
    installTypedCommandUx(pi);
}
