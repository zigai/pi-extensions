import type { ExtensionContext, WidgetPlacement } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { lexTypedArgumentString, parseTypedCommandArgs } from "../parser.js";
import {
    argumentValueHint,
    formatArgumentFlagName,
    isPositionalArgument,
    orderedCommandArgumentEntries,
} from "../schema.js";
import type {
    ArgumentDefinition,
    ArgumentValue,
    ParseIssue,
    RegisteredTypedCommand,
} from "../types.js";
import {
    commandDisplayName,
    editorTextForInvocation,
    type EditorTypedCommandInvocation,
} from "./editor-invocation.js";

/** Widget key used for the typed-command live helper. */
export const WIDGET_KEY = "pi-typed-commands.helper";

/** Default placement for the typed-command live helper. */
export const DEFAULT_HELPER_PLACEMENT: WidgetPlacement = "aboveEditor";

let submittedInvalidEditorText: string | undefined;
let currentHelperPlacement: WidgetPlacement = DEFAULT_HELPER_PLACEMENT;

// Pi command handlers and TUI session callbacks are registered independently, so this tiny
// process-local helper state is the compatibility seam between submitted command handling and
// helper rendering.

/** Record the current helper placement selected by extension options or project settings. */
export function setCurrentHelperPlacement(placement: WidgetPlacement): void {
    currentHelperPlacement = placement;
}

/** Return the process-local helper placement used by command handlers without a session reference. */
export function getCurrentHelperPlacement(): WidgetPlacement {
    return currentHelperPlacement;
}

/** Clear the editor text marker that forces inline validation display after command submission. */
export function clearSubmittedInvalidEditorText(): void {
    submittedInvalidEditorText = undefined;
}

/** Mark submitted editor text so the helper can show its inline validation immediately. */
export function markSubmittedInvalidEditorText(editorText: string): void {
    submittedInvalidEditorText = editorText;
}

/** Return a command's arguments in the order used by helper rendering. */
export function commandArgumentEntries(
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

function quoteInlineArgumentLabel(label: string): string {
    return `'${label}'`;
}

function bareInlineArgumentLabel(name: string, definition: ArgumentDefinition | undefined): string {
    if (definition === undefined) {
        return name;
    }
    return formatArgumentFlagName(name, definition).replace(/^--/, "");
}

function uniqueStrings(values: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        if (value.length === 0 || seen.has(value)) {
            continue;
        }
        seen.add(value);
        result.push(value);
    }
    return result;
}

function formatInlineIssueMessage(
    invocation: EditorTypedCommandInvocation,
    issue: ParseIssue,
): string {
    if (issue.name !== undefined) {
        const definition = invocation.command.args[issue.name];
        const label = bareInlineArgumentLabel(issue.name, definition);
        const quoted = quoteInlineArgumentLabel(label);
        const candidates = [issue.token ?? ""];
        if (definition !== undefined) {
            candidates.push(formatArgumentFlagName(issue.name, definition));
        }
        candidates.push(`--${label}`, label);
        const sortedCandidates = uniqueStrings(candidates).sort(
            (left, right) => right.length - left.length,
        );
        for (const candidate of sortedCandidates) {
            if (issue.message.startsWith(candidate)) {
                return `${quoted}${issue.message.slice(candidate.length)}`;
            }
        }
    }

    if (issue.kind === "unknown-argument" && issue.token !== undefined) {
        const label = quoteInlineArgumentLabel(issue.token.replace(/^-+/, ""));
        return issue.message.replace(issue.token, label);
    }

    return issue.message;
}

function inlineIssueLine(invocation: EditorTypedCommandInvocation): string | undefined {
    const parsed = parseTypedCommandArgs(invocation.command, invocation.rawArgs);
    const issue = parsed.issues.find(
        (item) => item.kind !== "missing-required" && shouldShowInlineIssue(invocation, item),
    );
    if (issue === undefined) {
        return undefined;
    }
    return `✕ ${formatInlineIssueMessage(invocation, issue)}`;
}

type HelperTheme = {
    fg(color: string, text: string): string;
};

/** Render the inline typed-command helper as TUI lines for the current editor invocation. */
export function renderInlineHelper(
    invocation: EditorTypedCommandInvocation,
    width: number,
    theme: HelperTheme,
): string[] {
    const tokens = collectInlineHelperTokens(invocation);
    const active = tokens.active.map((token) => `[${token}]`).join(" ");
    const required = tokens.required.map((token) => `[${token}]`).join(" ");
    const available = tokens.available.map((token) => `[${token}]`).join(" ");
    const commandPrefix = `/${commandDisplayName(invocation.command)}`;
    const helperIndent = " ".repeat(commandPrefix.length + 2);
    const tokenGroups: string[] = [];
    if (active.length > 0) {
        tokenGroups.push(theme.fg("accent", active));
    }
    if (required.length > 0) {
        tokenGroups.push(theme.fg("warning", required));
    }
    if (available.length > 0) {
        tokenGroups.push(theme.fg("dim", available));
    }
    const commandLine = `${helperIndent}${tokenGroups.join("  ")}`;
    const rendered = [truncateToWidth(commandLine, width, "")];
    const issueLine = inlineIssueLine(invocation);
    if (issueLine !== undefined) {
        rendered.push(truncateToWidth(`${helperIndent}${theme.fg("error", issueLine)}`, width, ""));
    }
    return rendered;
}

/** Set or clear the Pi helper widget for one extension context. */
export function setHelperWidget(
    ctx: ExtensionContext,
    invocation: EditorTypedCommandInvocation | undefined,
    placement: WidgetPlacement = currentHelperPlacement,
): void {
    if (invocation === undefined) {
        ctx.ui.setWidget(WIDGET_KEY, undefined, { placement });
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
        { placement },
    );
}
