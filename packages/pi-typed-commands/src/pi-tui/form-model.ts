import { formatFlagName, toKebabCase } from "../names.js";
import type {
    ArgumentDefinition,
    ArgumentValue,
    FormMode,
    ParsedCommandArguments,
    ParseIssue,
} from "../types.js";

export type FormState = Record<string, ArgumentValue>;

export type FormField = {
    name: string;
    definition: ArgumentDefinition;
    issueMessages: string[];
};

export type HeadlessFormModel = {
    state: FormState;
    fields: FormField[];
    initialSelection: number;
};

export function formatFormIssueMessage(issue: ParseIssue): string {
    if (issue.name === undefined) {
        return issue.message;
    }

    return issue.message.replaceAll(formatFlagName(issue.name), toKebabCase(issue.name));
}

export function issuesByName(parsed: ParsedCommandArguments): Map<string, string[]> {
    const issues = new Map<string, string[]>();
    for (const item of parsed.issues) {
        if (item.name === undefined) {
            continue;
        }
        const current = issues.get(item.name) ?? [];
        current.push(formatFormIssueMessage(item));
        issues.set(item.name, current);
    }
    return issues;
}

export function issueNames(parsed: ParsedCommandArguments): Set<string> {
    return new Set(issuesByName(parsed).keys());
}

export function shouldPromptArgument(
    name: string,
    definition: ArgumentDefinition,
    mode: FormMode,
    parsed: ParsedCommandArguments,
): boolean {
    if (mode === "all") {
        return true;
    }

    if (issueNames(parsed).has(name)) {
        return true;
    }

    if (definition.required === true && parsed.values[name] === undefined) {
        return true;
    }

    return false;
}

export function createHeadlessFormModel(
    definitions: Record<string, ArgumentDefinition>,
    parsed: ParsedCommandArguments,
    mode: FormMode,
): HeadlessFormModel {
    const state: FormState = { ...parsed.values };
    const namedIssues = issuesByName(parsed);
    const fields: FormField[] = [];
    let initialSelection = -1;

    for (const [name, definition] of Object.entries(definitions)) {
        if (initialSelection < 0 && shouldPromptArgument(name, definition, mode, parsed)) {
            initialSelection = fields.length;
        }
        fields.push({
            name,
            definition,
            issueMessages: namedIssues.get(name) ?? [],
        });
    }

    if (initialSelection < 0) {
        initialSelection = 0;
    }

    return { state, fields, initialSelection };
}
