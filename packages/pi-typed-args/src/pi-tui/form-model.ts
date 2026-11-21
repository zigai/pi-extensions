import { formatFlagName, toKebabCase } from "../names.ts";
import type {
    ArgumentDefinition,
    ArgumentValue,
    FlatArgumentDefinitions,
    FormMode,
    ParsedCommandArguments,
    ParseIssue,
} from "../types.ts";

export type FormState = Record<string, ArgumentValue>;

/** One rendered form field paired with validation messages already rewritten for form labels. */
export type FormField = {
    name: string;
    definition: ArgumentDefinition;
    issueMessages: string[];
    section?: string;
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

/** Group parser issues by argument name, dropping issues that are not attributable to one field. */
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
    definitions: FlatArgumentDefinitions,
    parsed: ParsedCommandArguments,
    mode: FormMode,
): HeadlessFormModel {
    const state = { ...parsed.values } satisfies FormState;
    for (const name of Object.keys(definitions)) {
        if (!Object.hasOwn(state, name) && Object.hasOwn(Object.prototype, name)) {
            Object.defineProperty(state, name, {
                configurable: true,
                enumerable: true,
                value: undefined,
                writable: true,
            });
        }
    }

    const namedIssues = issuesByName(parsed);
    const fields: FormField[] = [];
    let initialSelection = -1;

    for (const [name, definition] of Object.entries(definitions)) {
        if (mode === "missing" && !shouldPromptArgument(name, definition, mode, parsed)) {
            continue;
        }

        if (initialSelection < 0 && shouldPromptArgument(name, definition, "missing", parsed)) {
            initialSelection = fields.length;
        }

        let configuredSection = definition.ui?.section;
        if (configuredSection === undefined && definition.ui?.advanced === true) {
            configuredSection = "Advanced";
        }

        let groupPath: string | undefined;
        if (name.includes(".")) {
            groupPath = name.slice(0, name.lastIndexOf("."));
        }

        const field: FormField = {
            name,
            definition,
            issueMessages: namedIssues.get(name) ?? [],
        };
        const section = configuredSection ?? groupPath;
        if (section !== undefined) {
            field.section = section;
        }

        fields.push(field);
    }

    if (initialSelection < 0) {
        initialSelection = 0;
    }

    return { state, fields, initialSelection };
}
