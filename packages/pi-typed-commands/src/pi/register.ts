import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { defineTypedCommand } from "../command/definition.js";
import { createCommandHandle } from "../command/handle.js";
import { normalizeRegisteredCommand } from "../command/registered-command.js";
import { decideArgumentIssueAction } from "../invocation.js";
import { parseTypedCommandInvocation } from "../parser.js";
import type { OpenArgumentFormOptions } from "../form/open.js";
import { createPiCompletionCapabilities, getTypedArgumentCompletions } from "./completions.js";
import { getPiTypedCommandRegistry } from "./registry.js";
import { resolveTypedCommandFormTitle } from "./form-title.js";
import { takeExpandedFormArguments } from "./session-state.js";
import type { TypedCommandRegistry } from "../registry.js";
import type {
    ArgumentDefinitions,
    FlatArgumentDefinitions,
    FormMode,
    InferArguments,
    ParseIssue,
} from "../types.js";
import type {
    DefinedTypedCommand,
    RegisteredTypedCommand,
    TypedCommandDefinition,
    TypedCommandHandle,
    TypedSubcommandDefinitions,
} from "./command-types.js";
import { recordTypedCommandRecentValues } from "./presets.js";

/** Notify Pi users about one or more typed-command issues. */
export function notifyIssues(ctx: ExtensionContext, messages: string[]): void {
    if (messages.length === 0) {
        return;
    }
    ctx.ui.notify(messages.join("\n"), "error");
}

/** Return whether parse issues should notify directly instead of opening a form. */
export function shouldNotifyInsteadOfOpeningForm(issues: readonly ParseIssue[]): boolean {
    return issues.some((issue) => issue.kind !== "missing-required");
}

async function resolveCommandArguments<TDefinitions extends ArgumentDefinitions>(
    command: RegisteredTypedCommand<TDefinitions>,
    invocationName: string,
    rawArgs: string,
    ctx: ExtensionCommandContext,
    registry: TypedCommandRegistry,
): Promise<
    | {
          readonly command: RegisteredTypedCommand;
          readonly args: InferArguments<FlatArgumentDefinitions>;
      }
    | undefined
> {
    let editorText = `/${invocationName}`;
    if (rawArgs.length > 0) {
        editorText += ` ${rawArgs}`;
    }
    const routed = parseTypedCommandInvocation(command, rawArgs);
    let selectedCommand: RegisteredTypedCommand = command;
    if (routed.route.status === "subcommand" && routed.route.subcommand !== undefined) {
        selectedCommand = command.subcommands?.[routed.route.subcommand] ?? command;
    }
    const expandedFormArguments = takeExpandedFormArguments(ctx, invocationName, editorText);
    if (expandedFormArguments !== undefined) {
        return { command: selectedCommand, args: expandedFormArguments };
    }

    let parsed = routed.parsed;
    if (routed.route.status === "missing" && routed.parsed.mode !== "help" && ctx.hasUI) {
        let dialogOptions: { signal?: AbortSignal } | undefined;
        if (ctx.signal !== undefined) {
            dialogOptions = { signal: ctx.signal };
        }
        const subcommandName = await ctx.ui.select(
            "Select subcommand",
            Object.keys(command.subcommands ?? {}),
            dialogOptions,
        );
        if (subcommandName === undefined) {
            return undefined;
        }
        selectedCommand = command.subcommands?.[subcommandName] ?? command;
        parsed = parseTypedCommandInvocation(selectedCommand, "").parsed;
    }
    const { resolveTypedCommandSessionOptions } = await import("./session-state.js");
    const options = resolveTypedCommandSessionOptions(ctx);
    if (parsed.mode === "help") {
        const { notifyDetailedHelp } = await import("./help.js");
        notifyDetailedHelp(ctx, selectedCommand, options.appearance);
        return undefined;
    }

    const issueMessages = parsed.issues.map((item) => item.message);
    const formPolicy = selectedCommand.formPolicy ?? "missing";
    let formMode: FormMode = "missing";
    if (formPolicy === "always") {
        formMode = "all";
    }
    let issueAction = decideArgumentIssueAction(parsed.issues);
    if (formPolicy === "always") {
        issueAction = "open-form";
    } else if (formPolicy === "manual") {
        issueAction = "notify";
        if (parsed.issues.length === 0) {
            issueAction = "ok";
        }
    } else if (formPolicy === "invalid") {
        issueAction = "open-form";
        if (parsed.issues.length === 0) {
            issueAction = "ok";
        }
    } else if (
        shouldNotifyInsteadOfOpeningForm(parsed.issues) &&
        !parsed.issues.some((issue) => issue.kind === "missing-subcommand")
    ) {
        issueAction = "notify";
    }

    if (issueAction === "open-form") {
        if (!ctx.hasUI) {
            notifyIssues(ctx, issueMessages);
            return undefined;
        }
        const { openArgumentForm } = await import("../form/open.js");
        let formOptions: OpenArgumentFormOptions = {
            appearance: options.appearance,
            title: resolveTypedCommandFormTitle(command, ctx),
            completionCapabilities: createPiCompletionCapabilities(ctx.cwd, registry, ctx.signal),
        };
        if (ctx.signal !== undefined) {
            formOptions = {
                appearance: options.appearance,
                signal: ctx.signal,
                title: resolveTypedCommandFormTitle(command, ctx),
                completionCapabilities: createPiCompletionCapabilities(
                    ctx.cwd,
                    registry,
                    ctx.signal,
                ),
            };
        }
        const collected = await openArgumentForm(
            selectedCommand,
            parsed,
            formMode,
            ctx,
            formOptions,
        );
        if (collected === undefined) {
            return undefined;
        }
        if (
            selectedCommand.formPresets === true &&
            !recordTypedCommandRecentValues(ctx, selectedCommand, collected)
        ) {
            ctx.ui.notify("Typed command recent values could not be saved.", "warning");
        }
        return { command: selectedCommand, args: collected };
    }

    if (issueAction === "notify") {
        if (ctx.hasUI) {
            ctx.ui.setEditorText(editorText);
            const [
                { helperInvocationForEditorText },
                { setHelperWidget },
                { markSubmittedInvalidCommand },
            ] = await Promise.all([
                import("./editor-invocation.js"),
                import("./helper.js"),
                import("./session-state.js"),
            ]);
            if (!markSubmittedInvalidCommand(ctx, editorText)) {
                setHelperWidget(
                    ctx,
                    helperInvocationForEditorText(editorText, registry),
                    options.helperPlacement,
                    { submittedInvalidEditorText: editorText },
                    options.appearance.inlineHelp,
                );
            }
            return undefined;
        }
        notifyIssues(ctx, issueMessages);
        return undefined;
    }

    return {
        command: selectedCommand,
        // SAFETY: the parser has no issues, so the selected compiled grammar established every
        // required/defaulted leaf consumed by the registered handler.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: zero parser issues prove the handler value contract.
        args: parsed.values,
    };
}

/**
 * Register a Pi slash command with typed named arguments.
 *
 * The command is still registered with Pi's raw command system, but pi-typed-args parses,
 * validates, defaults, completes, and optionally prompts for arguments before calling `run`.
 */
export function registerTypedCommand<
    const TDefinitions extends ArgumentDefinitions,
    const TSubcommands extends TypedSubcommandDefinitions<TDefinitions>,
>(
    pi: ExtensionAPI,
    definition:
        | TypedCommandDefinition<TDefinitions, TSubcommands>
        | DefinedTypedCommand<TDefinitions, TSubcommands>,
): TypedCommandHandle<TDefinitions, TSubcommands>;
export function registerTypedCommand<
    TDefinitions extends ArgumentDefinitions,
    TSubcommands extends TypedSubcommandDefinitions<TDefinitions>,
>(
    pi: ExtensionAPI,
    definition:
        | TypedCommandDefinition<TDefinitions, TSubcommands>
        | DefinedTypedCommand<TDefinitions, TSubcommands>,
): TypedCommandHandle<TDefinitions, TSubcommands> {
    const name = definition.name;
    const registry = getPiTypedCommandRegistry();

    const command = normalizeRegisteredCommand(definition);
    let invocationName = name;
    const maybeInvocationName: unknown = pi.registerCommand(name, {
        description: command.description,
        async getArgumentCompletions(argumentPrefix) {
            return getTypedArgumentCompletions(
                command,
                argumentPrefix,
                createPiCompletionCapabilities(process.cwd(), registry),
            );
        },
        handler: async (rawArgs, ctx) => {
            const invocation = await resolveCommandArguments(
                command,
                invocationName,
                rawArgs,
                ctx,
                registry,
            );
            if (invocation === undefined) {
                return;
            }
            if (invocation.command.target?.kind !== "extension") {
                ctx.ui.notify(
                    `Typed command /${name} does not have an extension handler.`,
                    "error",
                );
                return;
            }
            await invocation.command.target.run(invocation.args, ctx);
        },
    });

    let piInvocationName: string | undefined;
    if (typeof maybeInvocationName === "string") {
        piInvocationName = maybeInvocationName;
    }
    if (piInvocationName === undefined) {
        invocationName = registry.register(command);
    } else {
        invocationName = registry.register(command, {
            invocationName: piInvocationName,
        });
    }
    const definedCommand = defineTypedCommand(definition);
    return createCommandHandle(definedCommand, command, invocationName, (registered) => {
        registry.unregister(registered);
    });
}
