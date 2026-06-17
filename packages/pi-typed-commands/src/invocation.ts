import type { ParseIssue } from "./types.js";

export type TypedCommandPreflightReason = "disabled" | "bypassed";

export type TypedCommandPreflightDecision =
    | { action: "typed" }
    | { action: "fallback"; reason: TypedCommandPreflightReason }
    | { action: "stop"; reason: TypedCommandPreflightReason };

export type TypedCommandPreflightOptions = {
    typedCommandEnabled: boolean;
    shouldUseTypedArgs: boolean;
    hasFallback: boolean;
};

export type ArgumentIssueAction = "ok" | "open-form" | "notify";

export type ArgumentIssuePolicy = {
    openFormWhenInvalid: boolean;
    openFormWhenMissingRequired: boolean;
};

export type ParsedSlashCommandText = {
    commandName: string;
    rawArgs: string;
    trailingBody: string;
};

/** Decide whether a command invocation should use typed parsing, raw fallback, or stop early. */
export function decideTypedCommandPreflight(
    options: TypedCommandPreflightOptions,
): TypedCommandPreflightDecision {
    if (!options.typedCommandEnabled) {
        if (options.hasFallback) {
            return { action: "fallback", reason: "disabled" };
        }
        return { action: "stop", reason: "disabled" };
    }

    if (!options.shouldUseTypedArgs) {
        if (options.hasFallback) {
            return { action: "fallback", reason: "bypassed" };
        }
        return { action: "stop", reason: "bypassed" };
    }

    return { action: "typed" };
}

/** Decide whether parser/validation issues should notify directly or open the argument form. */
export function decideArgumentIssueAction(
    policy: ArgumentIssuePolicy,
    issues: ParseIssue[],
): ArgumentIssueAction {
    if (issues.length === 0) {
        return "ok";
    }

    let openForm = policy.openFormWhenInvalid;
    let hasStructuralIssue = false;
    for (const issue of issues) {
        if (issue.kind === "missing-required" && policy.openFormWhenMissingRequired) {
            openForm = true;
        }
        if (issue.name === undefined) {
            hasStructuralIssue = true;
        }
    }

    if (hasStructuralIssue) {
        openForm = false;
    }

    if (openForm) {
        return "open-form";
    }
    return "notify";
}

/** Parse a slash-command input while preserving any body text after the first line. */
export function parseSlashCommandText(text: string): ParsedSlashCommandText | undefined {
    let firstLine = text;
    let trailingBody = "";
    const newlineIndex = text.indexOf("\n");
    if (newlineIndex >= 0) {
        firstLine = text.slice(0, newlineIndex);
        trailingBody = text.slice(newlineIndex + 1);
    }

    const match = /^\/(\S+)(?:\s+(.*))?$/.exec(firstLine);
    if (match === null) {
        return undefined;
    }

    const commandName = match[1];
    if (commandName === undefined) {
        return undefined;
    }

    let rawArgs = "";
    if (match[2] !== undefined) {
        rawArgs = match[2];
    }

    return {
        commandName,
        rawArgs,
        trailingBody,
    };
}

/** Combine parser leftovers and body text into the typed-skill ADDITIONAL_INPUT payload. */
export function combineSkillAdditionalInput(
    parsedAdditionalInput: string,
    trailingBody: string,
): string {
    const sections: string[] = [];

    const parsed = parsedAdditionalInput.trim();
    if (parsed.length > 0) {
        sections.push(parsed);
    }

    const body = trailingBody.trim();
    if (body.length > 0) {
        sections.push(body);
    }

    return sections.join("\n");
}
