import type { ParseIssue } from "./types.js";

export type ArgumentIssueAction = "ok" | "open-form" | "notify";

export type ParsedSlashCommandText = {
    commandName: string;
    rawArgs: string;
    trailingBody: string;
};

/** Decide whether parser/validation issues should notify directly or open the argument form. */
export function decideArgumentIssueAction(issues: readonly ParseIssue[]): ArgumentIssueAction {
    if (issues.length === 0) {
        return "ok";
    }

    for (const issue of issues) {
        if (issue.name === undefined) {
            return "notify";
        }
    }

    return "open-form";
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

/** Combine parser leftovers and body text into the typed-skill additional-input payload. */
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
