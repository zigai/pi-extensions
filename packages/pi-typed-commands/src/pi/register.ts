import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { defineTypedCommand } from "../command/definition.js";
import { createCommandHandle } from "../command/handle.js";
import { normalizeRegisteredCommand } from "../command/registered-command.js";
import { decideArgumentIssueAction } from "../invocation.js";
import { parseTypedCommandArgs } from "../parser.js";
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
} from "./command-types.js";

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
): Promise<InferArguments<FlatArgumentDefinitions> | undefined> {
    let editorText = `/${invocationName}`;
    if (rawArgs.length > 0) {
        editorText += ` ${rawArgs}`;
    }
    const expandedFormArguments = takeExpandedFormArguments(ctx, invocationName, editorText);
    if (expandedFormArguments !== undefined) {
        return expandedFormArguments;
    }

    const parsed = parseTypedCommandArgs(command, rawArgs);
    const { resolveTypedCommandSessionOptions } = await import("./session-state.js");
    const options = resolveTypedCommandSessionOptions(ctx);
    if (parsed.mode === "help") {
        const { notifyDetailedHelp } = await import("./help.js");
        notifyDetailedHelp(ctx, command, options.appearance);
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
        const { openArgumentForm } = await import("../form/open.js");
        let formOptions: OpenArgumentFormOptions = {
            appearance: options.appearance,
            title: resolveTypedCommandFormTitle(command, ctx),
        };
        if (ctx.signal !== undefined) {
            formOptions = {
                appearance: options.appearance,
                signal: ctx.signal,
                title: resolveTypedCommandFormTitle(command, ctx),
            };
        }
        const collected = await openArgumentForm(command, parsed, formMode, ctx, formOptions);
        if (collected === undefined) {
            return undefined;
        }
        return collected;
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

    return parsed.values;
}

/**
 * Register a Pi slash command with typed named arguments.
 *
 * The command is still registered with Pi's raw command system, but pi-typed-args parses,
 * validates, defaults, completes, and optionally prompts for arguments before calling `run`.
 */
export function registerTypedCommand<const TDefinitions extends ArgumentDefinitions>(
    pi: ExtensionAPI,
    definition: TypedCommandDefinition<TDefinitions> | DefinedTypedCommand<TDefinitions>,
): TypedCommandHandle<TDefinitions>;
export function registerTypedCommand<TDefinitions extends ArgumentDefinitions>(
    pi: ExtensionAPI,
    definition: TypedCommandDefinition<TDefinitions> | DefinedTypedCommand<TDefinitions>,
): TypedCommandHandle<TDefinitions> {
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
            const args = await resolveCommandArguments(
                command,
                invocationName,
                rawArgs,
                ctx,
                registry,
            );
            if (args === undefined) {
                return;
            }
            if (command.target?.kind !== "extension") {
                ctx.ui.notify(
                    `Typed command /${name} does not have an extension handler.`,
                    "error",
                );
                return;
            }
            await command.target.run(args, ctx);
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
