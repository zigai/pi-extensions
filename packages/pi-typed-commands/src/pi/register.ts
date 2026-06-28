import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineTypedCommand } from "../command/definition.js";
import { createCommandHandle } from "../command/handle.js";
import { normalizeRegisteredCommand } from "../command/registered-command.js";
import { getTypedArgumentCompletions } from "../completions.js";
import { decideArgumentIssueAction } from "../invocation.js";
import { parseTypedCommandArgs } from "../parser.js";
import { registerTypedCommandMetadata } from "../registry.js";
import { openArgumentForm } from "../form/open.js";
import type {
    ArgumentDefinitions,
    DefinedTypedCommand,
    FlatArgumentDefinitions,
    FormMode,
    InferArguments,
    ParseIssue,
    RegisteredTypedCommand,
    TypedCommandDefinition,
    TypedCommandHandle,
} from "../types.js";
import { helperInvocationForEditorText } from "./editor-invocation.js";
import { notifyDetailedHelp } from "./help.js";
import { setHelperWidget } from "./helper.js";
import { markSubmittedInvalidCommand } from "./session-state.js";
import { resolveTypedCommandUxOptions } from "./settings.js";

/** Notify Pi users about one or more typed-command issues. */
export function notifyIssues(ctx: ExtensionCommandContext, messages: string[]): void {
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
): Promise<InferArguments<FlatArgumentDefinitions> | undefined> {
    const parsed = parseTypedCommandArgs(command, rawArgs);
    if (parsed.mode === "help") {
        notifyDetailedHelp(ctx, command);
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
        return collected;
    }

    if (issueAction === "notify") {
        if (ctx.hasUI) {
            let editorText = `/${invocationName}`;
            if (rawArgs.length > 0) {
                editorText += ` ${rawArgs}`;
            }
            ctx.ui.setEditorText(editorText);
            if (!markSubmittedInvalidCommand(ctx, editorText)) {
                const options = resolveTypedCommandUxOptions({}, ctx);
                setHelperWidget(
                    ctx,
                    helperInvocationForEditorText(editorText),
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
 * The command is still registered with Pi's raw command system, but pi-typed-commands parses,
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

    const command = normalizeRegisteredCommand(definition);
    let invocationName = name;
    const maybeInvocationName: unknown = pi.registerCommand(name, {
        description: command.description,
        getArgumentCompletions(argumentPrefix) {
            return getTypedArgumentCompletions(command, argumentPrefix);
        },
        handler: async (rawArgs, ctx) => {
            const args = await resolveCommandArguments(command, invocationName, rawArgs, ctx);
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
        invocationName = registerTypedCommandMetadata(command);
    } else {
        invocationName = registerTypedCommandMetadata(command, {
            invocationName: piInvocationName,
        });
    }
    const definedCommand = defineTypedCommand(definition);
    return createCommandHandle(definedCommand, command, invocationName);
}
