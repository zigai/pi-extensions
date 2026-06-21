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
import {
    lexTypedArgumentString,
    parseTypedCommandArgs,
    serializeTypedCommandArgs,
    toTypedParseResult,
} from "./parser.js";
import {
    combineSkillAdditionalInput,
    decideArgumentIssueAction,
    parseSlashCommandText,
} from "./invocation.js";
import {
    getTypedCommand,
    getTypedSkillDiagnostics,
    onTypedCommandsChanged,
    registerTypedCommandMetadata,
    replaceTypedSkillMetadata,
    unregisterTypedCommandMetadata,
} from "./registry.js";
import type {
    ArgumentDefinition,
    ArgumentDefinitions,
    ArgumentValue,
    DefinedTypedCommand,
    InferArguments,
    ParsedCommandArguments,
    ParseIssue,
    RegisteredTypedCommand,
    TypedCommandDefinition,
    TypedCommandHandler,
    TypedCommandFormSymbols,
    TypedCommandHandle,
    TypedCommandOptions,
    TypedCommandRefinement,
    TypedParseResult,
    FormMode,
} from "./types.js";
import { formatCommandUsage, formatDetailedHelp } from "./usage.js";
import {
    argumentValueHint,
    formatArgumentFlagName,
    isPositionalArgument,
    orderedCommandArgumentEntries,
} from "./schema.js";
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
let submittedInvalidEditorText: string | undefined;

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
    TypedCommandDefinition,
    TypedCommandHandler,
    TypedCommandHandle,
    TypedCommandOptions,
    TypedCompletionContext,
    TypedCompletionItem,
    TypedCompletionProvider,
    TypedCompletionReplacementRange,
    TypedCommandRefinement,
    TypedCommandRefinementContext,
    TypedCommandRefinementIssue,
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

function shouldNotifyInsteadOfOpeningForm(issues: readonly ParseIssue[]): boolean {
    return issues.some((issue) => issue.kind !== "missing-required");
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
    let issueAction = decideArgumentIssueAction(parsed.issues);
    if (shouldNotifyInsteadOfOpeningForm(parsed.issues)) {
        issueAction = "notify";
    }

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
        if (ctx.hasUI) {
            const commandName = command.invocationName ?? command.name;
            let editorText = `/${commandName}`;
            if (rawArgs.length > 0) {
                editorText += ` ${rawArgs}`;
            }
            submittedInvalidEditorText = editorText;
            ctx.ui.setEditorText(editorText);
            setHelperWidget(ctx, helperInvocationForEditorText(editorText));
            return undefined;
        }
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
        formSymbols: DEFAULT_FORM_SYMBOLS,
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
        formSymbols: { ...DEFAULT_FORM_SYMBOLS, ...options.formSymbols },
        source: "extension",
    };

    const refine = maybeWrapGroupedRefinement(options.args, options.refine);
    if (refine !== undefined) {
        command.refine = refine;
    }
    if (options.formTitle !== undefined) {
        command.formTitle = options.formTitle;
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
    if (definition.formTitle !== undefined) {
        options.formTitle = definition.formTitle;
    }
    if (definition.formSymbols !== undefined) {
        options.formSymbols = definition.formSymbols;
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

/**
 * Register a Pi slash command with typed named arguments.
 *
 * The command is still registered with Pi's raw command system, but pi-typed-commands parses,
 * validates, defaults, completes, and optionally prompts for arguments before calling `handler`.
 */
export function registerTypedCommand<const TDefinitions extends ArgumentDefinitions>(
    pi: ExtensionAPI,
    definition: TypedCommandDefinition<TDefinitions> | DefinedTypedCommand<TDefinitions>,
): TypedCommandHandle<TDefinitions>;
export function registerTypedCommand<const TDefinitions extends ArgumentDefinitions>(
    pi: ExtensionAPI,
    name: string,
    options: TypedCommandOptions<TDefinitions>,
): TypedCommandHandle<TDefinitions>;
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
): EditorTypedCommandInvocation | undefined {
    const match = slashCommandMatch(editorText);
    if (match === undefined) {
        return undefined;
    }

    const command = getTypedCommand(match.commandName);
    if (command === undefined) {
        return undefined;
    }

    return {
        command,
        rawArgs: match.rawArgs,
        trailingBody: match.trailingBody,
    };
}

function notifySkillDiagnosticsForText(text: string, ctx: ExtensionCommandContext): boolean {
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

function helperInvocationForEditorText(
    editorText: string,
): EditorTypedCommandInvocation | undefined {
    const invocation = commandInvocationForEditorText(editorText);
    if (invocation === undefined) {
        return undefined;
    }

    const { command } = invocation;

    if (Object.keys(command.args).length === 0) {
        return undefined;
    }

    return invocation;
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
    let issueAction = decideArgumentIssueAction(parsed.issues);
    if (shouldNotifyInsteadOfOpeningForm(parsed.issues)) {
        issueAction = "notify";
    }

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
    const invocation = commandInvocationForEditorText(text);
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
    const invocation = commandInvocationForEditorText(ctx.ui.getEditorText());
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

function commandDisplayName(command: RegisteredTypedCommand): string {
    return command.invocationName ?? command.name;
}

function commandArgumentEntries(
    command: RegisteredTypedCommand,
): Array<[string, ArgumentDefinition]> {
    return orderedCommandArgumentEntries(command);
}

function helperAvailableToken(name: string, definition: ArgumentDefinition): string {
    if (isPositionalArgument(definition)) {
        return name;
    }
    if (definition.type === "boolean") {
        return formatArgumentFlagName(name, definition);
    }
    return `${formatArgumentFlagName(name, definition)} <${argumentValueHint(definition, name)}>`;
}

function helperHasNamedFlag(rawArgs: string): boolean {
    return /(?:^|\s)--?[^\s-]/.test(rawArgs);
}

function formatHelperValue(value: unknown): string {
    if (Array.isArray(value)) {
        return value.map((item) => formatHelperValue(item)).join(",");
    }
    if (value === undefined) {
        return "?";
    }
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    return JSON.stringify(value);
}

function providedHelperToken(name: string, definition: ArgumentDefinition, value: unknown): string {
    if (isPositionalArgument(definition)) {
        return `${name}=${formatHelperValue(value)}`;
    }
    const flag = formatArgumentFlagName(name, definition);
    if (definition.type === "boolean") {
        if (value === true) {
            return flag;
        }
        return `${flag}=false`;
    }
    return `${flag}=${formatHelperValue(value)}`;
}

type InlineHelperTokens = {
    active: string[];
    required: string[];
    available: string[];
};

function shouldDisplayDefaultToken(
    definition: ArgumentDefinition,
    value: ArgumentValue | undefined,
): boolean {
    if (value === undefined) {
        return false;
    }
    if (definition.type === "boolean") {
        return value === true;
    }
    if (definition.type === "multi-enum" && Array.isArray(value)) {
        return value.length > 0;
    }
    return true;
}

function defaultHelperToken(
    name: string,
    definition: ArgumentDefinition,
    value: ArgumentValue | undefined,
): string {
    if (isPositionalArgument(definition)) {
        return `${name}=${formatHelperValue(value)}`;
    }
    const flag = formatArgumentFlagName(name, definition);
    if (definition.type === "boolean") {
        return `${flag}=true`;
    }
    return `${flag}=${formatHelperValue(value)}`;
}

function collectInlineHelperTokens(invocation: EditorTypedCommandInvocation): InlineHelperTokens {
    const parsed = parseTypedCommandArgs(invocation.command, invocation.rawArgs);
    const hasNamedFlag = helperHasNamedFlag(invocation.rawArgs);
    const active: string[] = [];
    const required: string[] = [];
    const available: string[] = [];

    for (const [name, definition] of commandArgumentEntries(invocation.command)) {
        const value = parsed.values[name];
        const source = parsed.sources?.get(name);
        if (parsed.provided.has(name)) {
            active.push(providedHelperToken(name, definition, value));
            continue;
        }
        if (source === "default" && shouldDisplayDefaultToken(definition, value)) {
            active.push(defaultHelperToken(name, definition, value));
            continue;
        }
        if (hasNamedFlag && isPositionalArgument(definition)) {
            continue;
        }
        if (definition.required === true) {
            required.push(helperAvailableToken(name, definition));
        } else {
            available.push(helperAvailableToken(name, definition));
        }
    }

    return { active, required, available };
}

function editorTextForInvocation(invocation: EditorTypedCommandInvocation): string {
    let text = `/${commandDisplayName(invocation.command)}`;
    if (invocation.rawArgs.length > 0) {
        text += ` ${invocation.rawArgs}`;
    }
    if (invocation.trailingBody.length > 0) {
        text += `\n${invocation.trailingBody}`;
    }
    return text;
}

type ArgumentToken = { raw: string; value: string };

function lastArgumentToken(rawArgs: string): ArgumentToken | undefined {
    const tokens = lexTypedArgumentString(rawArgs).tokens;
    const token = tokens[tokens.length - 1];
    if (token === undefined) {
        return undefined;
    }
    return { raw: token.raw, value: token.value };
}

function issueMatchesArgumentToken(issue: ParseIssue, token: ArgumentToken): boolean {
    return issue.token === token.raw || issue.token === token.value;
}

function shouldShowInlineIssue(
    invocation: EditorTypedCommandInvocation,
    issue: ParseIssue,
): boolean {
    if (editorTextForInvocation(invocation) === submittedInvalidEditorText) {
        return true;
    }

    const lastToken = lastArgumentToken(invocation.rawArgs);
    if (lastToken === undefined) {
        return false;
    }

    const issueIsForLastToken = issueMatchesArgumentToken(issue, lastToken);
    if (issue.kind === "missing-value") {
        return !issueIsForLastToken;
    }
    if (issue.kind === "unterminated-quote") {
        return false;
    }
    if (issueIsForLastToken) {
        return /\s$/.test(invocation.rawArgs);
    }
    return true;
}

function inlineIssueLine(invocation: EditorTypedCommandInvocation): string | undefined {
    const parsed = parseTypedCommandArgs(invocation.command, invocation.rawArgs);
    const issue = parsed.issues.find(
        (item) => item.kind !== "missing-required" && shouldShowInlineIssue(invocation, item),
    );
    if (issue === undefined) {
        return undefined;
    }
    return `error: ${issue.message}`;
}

type TabCompletionResult = { handled: false } | { handled: true; editorText?: string };

type FlagCompletionCandidate = {
    stem: string;
    replacement: string;
};

function flagCompletionCandidates(
    command: RegisteredTypedCommand,
    token: string,
): FlagCompletionCandidate[] {
    const stem = token.replace(/^-+/, "");
    if (stem.length === 0) {
        return [];
    }

    const candidates: FlagCompletionCandidate[] = [];
    const seen = new Set<string>();
    for (const [name, definition] of commandArgumentEntries(command)) {
        if (isPositionalArgument(definition)) {
            continue;
        }
        const replacement = formatArgumentFlagName(name, definition);
        const primary = replacement.replace(/^--/, "");
        const searchable = [primary, ...(definition.aliases ?? [])];
        for (const item of searchable) {
            if (!item.startsWith(stem) || seen.has(replacement)) {
                continue;
            }
            seen.add(replacement);
            candidates.push({ stem: item, replacement });
        }
    }
    return candidates;
}

function bestFlagCompletion(command: RegisteredTypedCommand, token: string): string | undefined {
    const stem = token.replace(/^-+/, "");
    const candidates = flagCompletionCandidates(command, token);
    const exact = candidates.find((candidate) => candidate.stem === stem);
    if (exact !== undefined) {
        return exact.replacement;
    }
    if (candidates.length === 1) {
        return candidates[0]?.replacement;
    }
    return undefined;
}

function completePartialFlagOnTab(editorText: string): TabCompletionResult {
    const invocation = commandInvocationForEditorText(editorText);
    if (invocation === undefined) {
        return { handled: false };
    }

    const firstLineEnd = editorText.indexOf("\n");
    let firstLine = editorText;
    let rest = "";
    if (firstLineEnd >= 0) {
        firstLine = editorText.slice(0, firstLineEnd);
        rest = editorText.slice(firstLineEnd);
    }

    const tokenMatch = /(?:^|\s)(-\S*)$/.exec(firstLine);
    if (tokenMatch === null) {
        return { handled: false };
    }

    const token = tokenMatch[1];
    if (token === undefined) {
        return { handled: false };
    }

    const replacement = bestFlagCompletion(invocation.command, token);
    if (replacement === undefined) {
        return { handled: true };
    }

    const tokenStart = firstLine.length - token.length;
    const completedLine = `${firstLine.slice(0, tokenStart)}${replacement} `;
    return { handled: true, editorText: `${completedLine}${rest}` };
}

type HelperTheme = {
    fg(color: string, text: string): string;
};

function renderInlineHelper(
    invocation: EditorTypedCommandInvocation,
    width: number,
    theme: HelperTheme,
): string[] {
    const tokens = collectInlineHelperTokens(invocation);
    const active = tokens.active.map((token) => `[${token}]`).join(" ");
    const required = tokens.required.map((token) => `[${token}]`).join(" ");
    const available = tokens.available.map((token) => `[${token}]`).join(" ");
    let commandLine = theme.fg("accent", `/${commandDisplayName(invocation.command)}`);
    if (active.length > 0) {
        commandLine += " " + theme.fg("accent", active);
    }
    if (required.length > 0) {
        commandLine += "  " + theme.fg("warning", required);
    }
    if (available.length > 0) {
        commandLine += "  " + theme.fg("dim", available);
    }
    const rendered = [truncateToWidth(commandLine, width, "")];
    const issueLine = inlineIssueLine(invocation);
    if (issueLine !== undefined) {
        rendered.push(truncateToWidth(theme.fg("error", issueLine), width, ""));
    }
    return rendered;
}

function setHelperWidget(
    ctx: ExtensionContext,
    invocation: EditorTypedCommandInvocation | undefined,
): void {
    if (invocation === undefined) {
        ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
        return;
    }

    ctx.ui.setWidget(
        WIDGET_KEY,
        (_tui, theme) => ({
            render(width: number): string[] {
                return renderInlineHelper(invocation, width, theme);
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
        const helperInvocation = helperInvocationForEditorText(ctx.ui.getEditorText());
        setHelperWidget(ctx, helperInvocation);
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
            submittedInvalidEditorText = undefined;
            this.scheduleRefresh(ctx);
            return undefined;
        }

        const editorText = ctx.ui.getEditorText();
        const completion = completePartialFlagOnTab(editorText);
        if (completion.handled === true) {
            if ("editorText" in completion && completion.editorText !== undefined) {
                ctx.ui.setEditorText(completion.editorText);
            }
            this.scheduleRefresh(ctx);
            return { consume: true };
        }

        if (commandInvocationForEditorText(editorText) === undefined) {
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
                if (
                    commandInvocationForEditorText(
                        (lines[cursorLine] ?? "").slice(0, cursorCol),
                    ) !== undefined
                ) {
                    return null;
                }

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
export function installTypedCommandUx(pi: ExtensionAPI): void {
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
