import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openArgumentForm } from "../form/open.js";
import { combineSkillAdditionalInput, decideArgumentIssueAction } from "../invocation.js";
import { parseTypedCommandArgs } from "../parser.js";
import type { TypedCommandRegistry } from "../registry.js";
import {
    isTypedSkillCommand,
    skillPathFromCommand,
    typedSkillCommandFromMetadata,
} from "../skills/command.js";
import { formatTypedSkillDiagnostics } from "../skills/diagnostics.js";
import { readTypedSkillMetadataResult } from "../skills/metadata.js";
import { renderTypedSkillInvocation } from "../skills/prompt.js";
import type { TypedSkillDiagnostics } from "../skills/types.js";
import type { FormMode, ParsedCommandArguments, RegisteredTypedCommand } from "../types.js";
import { commandInvocationForEditorText, slashCommandMatch } from "./editor-invocation.js";
import { notifyDetailedHelp } from "./help.js";
import type { ResolvedPiTypedCommandsAppearance } from "./presentation-config.js";
import { notifyIssues, shouldNotifyInsteadOfOpeningForm } from "./register.js";

type SkillParseResult = {
    parsed: ParsedCommandArguments;
    additionalInput: string;
};

type TypedSkillInputResult = { action: "handled" } | { action: "transform"; text: string };

/** Refresh process-local typed skill metadata from Pi's current skill command list. */
export function refreshTypedSkills(pi: ExtensionAPI, registry: TypedCommandRegistry): void {
    const commands: RegisteredTypedCommand[] = [];
    const diagnostics: TypedSkillDiagnostics[] = [];
    for (const command of pi.getCommands()) {
        const skillPath = skillPathFromCommand(command);
        if (skillPath === undefined) {
            continue;
        }
        const fallbackName = command.name.replace(/^skill:/, "");
        const result = readTypedSkillMetadataResult(skillPath, { fallbackName });
        if (result.status === "ok") {
            commands.push(typedSkillCommandFromMetadata(result.metadata));
        }
        if (result.status === "invalid") {
            diagnostics.push(result.diagnostics);
        }
    }
    registry.replaceSkills(commands, diagnostics);
}

/** Notify when editor text targets a skill whose typed arguments could not be registered. */
export function notifySkillDiagnosticsForText(
    text: string,
    ctx: ExtensionContext,
    registry: TypedCommandRegistry,
): boolean {
    const match = slashCommandMatch(text);
    if (match === undefined) {
        return false;
    }
    const diagnostics = registry.getSkillDiagnostics(match.commandName);
    if (diagnostics === undefined) {
        return false;
    }
    ctx.ui.notify(formatTypedSkillDiagnostics(diagnostics), "error");
    return true;
}

function parseSkillArguments(
    command: RegisteredTypedCommand,
    rawArgs: string,
    trailingBody: string,
): SkillParseResult {
    const parsedResult = parseTypedCommandArgs(command, rawArgs);
    const additionalTokens: string[] = [];
    const issues = parsedResult.issues.filter((issue) => {
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
        parsed: { ...parsedResult, issues },
        additionalInput: combineSkillAdditionalInput(additionalTokens.join(" "), trailingBody),
    };
}

/** Render typed skill input or open prompts/notifications when required. */
export async function renderTypedSkillInput(
    command: RegisteredTypedCommand,
    rawArgs: string,
    trailingBody: string,
    ctx: ExtensionContext,
    formMode: FormMode,
    appearance: ResolvedPiTypedCommandsAppearance,
    signal?: AbortSignal,
): Promise<string | undefined> {
    if (!isTypedSkillCommand(command)) {
        return undefined;
    }

    const { parsed, additionalInput } = parseSkillArguments(command, rawArgs, trailingBody);
    if (parsed.mode === "help") {
        notifyDetailedHelp(ctx, command, appearance);
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
        const collected = await openArgumentForm(command, parsed, formMode, ctx, {
            appearance,
            ...(signal === undefined ? {} : { signal }),
        });
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

/** Transform a typed skill slash-command input into the model-facing skill prompt. */
export async function transformTypedSkillInput(
    text: string,
    ctx: ExtensionContext,
    registry: TypedCommandRegistry,
    appearance: ResolvedPiTypedCommandsAppearance,
    formMode: FormMode = "missing",
    signal?: AbortSignal,
): Promise<TypedSkillInputResult | undefined> {
    const invocation = commandInvocationForEditorText(text, registry);
    if (invocation === undefined || !isTypedSkillCommand(invocation.command)) {
        return undefined;
    }

    const transformed = await renderTypedSkillInput(
        invocation.command,
        invocation.rawArgs,
        invocation.trailingBody,
        ctx,
        formMode,
        appearance,
        signal,
    );
    if (transformed === undefined) {
        return { action: "handled" };
    }
    return { action: "transform", text: transformed };
}
