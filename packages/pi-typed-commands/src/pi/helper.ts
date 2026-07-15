import type { ExtensionContext, WidgetPlacement } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { casesHandled } from "../exhaustive.js";
import { lexTypedArgumentString, parseTypedCommandArgs } from "../parser.js";
import {
    argumentFlagNames,
    argumentTypeHint,
    argumentValueHint,
    formatArgumentFlagName,
    isPositionalArgument,
    orderedCommandArgumentEntries,
} from "../schema.js";
import type {
    ArgumentDefinition,
    ArgumentValue,
    ParseIssue,
} from "../types.js";
import type { RegisteredTypedCommand } from "./command-types.js";
import {
    commandDisplayName,
    editorTextForInvocation,
    type EditorTypedCommandInvocation,
} from "./editor-invocation.js";
import {
    DEFAULT_PI_TYPED_COMMANDS_APPEARANCE,
    type InlineHelpOrder,
    type ResolvedInlineHelpAppearance,
} from "./presentation-config.js";

/** Widget key used for the typed-command live helper. */
export const WIDGET_KEY = "pi-typed-args.helper";

/** Default placement for the typed-command live helper. */
export const DEFAULT_HELPER_PLACEMENT: WidgetPlacement = "aboveEditor";

export type HelperRenderState = {
    submittedInvalidEditorText?: string | undefined;
};

/** Return a command's arguments in the order used by helper rendering. */
export function commandArgumentEntries(
    command: RegisteredTypedCommand,
): Array<[string, ArgumentDefinition]> {
    return orderedCommandArgumentEntries(command);
}

function helperValueHint(
    name: string,
    definition: ArgumentDefinition,
    appearance: ResolvedInlineHelpAppearance,
): string {
    if (
        appearance.metadata.enumValues === false &&
        (definition.type === "enum" || definition.type === "multi-enum") &&
        definition.placeholder === undefined
    ) {
        return argumentTypeHint(definition);
    }
    return argumentValueHint(definition, name);
}

function helperAvailableToken(
    name: string,
    definition: ArgumentDefinition,
    appearance: ResolvedInlineHelpAppearance,
): string {
    if (isPositionalArgument(definition)) {
        return name;
    }
    if (definition.type === "boolean") {
        return formatArgumentFlagName(name, definition);
    }
    return `${formatArgumentFlagName(name, definition)} <${helperValueHint(
        name,
        definition,
        appearance,
    )}>`;
}

function helperHasNamedFlag(rawArgs: string): boolean {
    return /(?:^|\s)--?[^\s-]/.test(rawArgs);
}

function isHelperMultiValue(value: ArgumentValue): value is readonly string[] {
    return Array.isArray(value);
}

function formatHelperValue(value: ArgumentValue): string {
    if (isHelperMultiValue(value)) {
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
    return casesHandled(value);
}

function providedHelperToken(
    name: string,
    definition: ArgumentDefinition,
    value: ArgumentValue,
    valueSeparator: string,
): string {
    if (isPositionalArgument(definition)) {
        return `${name}${valueSeparator}${formatHelperValue(value)}`;
    }
    const flag = formatArgumentFlagName(name, definition);
    if (definition.type === "boolean") {
        if (value === true) {
            return flag;
        }
        return `${flag}${valueSeparator}false`;
    }
    return `${flag}${valueSeparator}${formatHelperValue(value)}`;
}

type InlineHelpDisplayState = "active" | "required" | "available";

type InlineHelpValueSource = "provided" | "default";

type InlineHelpItem = {
    name: string;
    definition: ArgumentDefinition;
    state: InlineHelpDisplayState;
    valueSource?: InlineHelpValueSource;
    value?: ArgumentValue;
    index: number;
};

type InlineTokenCoreSegments = {
    beforeType: string;
    typeSuffix: string | undefined;
    afterType: string;
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
    valueSeparator: string,
): string {
    if (isPositionalArgument(definition)) {
        return `${name}${valueSeparator}${formatHelperValue(value)}`;
    }
    const flag = formatArgumentFlagName(name, definition);
    if (definition.type === "boolean") {
        return `${flag}${valueSeparator}true`;
    }
    return `${flag}${valueSeparator}${formatHelperValue(value)}`;
}

function collectInlineHelperItems(
    invocation: EditorTypedCommandInvocation,
    appearance: ResolvedInlineHelpAppearance,
): InlineHelpItem[] {
    const parsed = parseTypedCommandArgs(invocation.command, invocation.rawArgs);
    const hasNamedFlag = helperHasNamedFlag(invocation.rawArgs);
    const items: InlineHelpItem[] = [];

    const entries = commandArgumentEntries(invocation.command);
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry === undefined) {
            continue;
        }
        const [name, definition] = entry;
        const value = parsed.values[name];
        const source = parsed.sources?.get(name);
        if (parsed.provided.has(name)) {
            items.push({
                name,
                definition,
                state: "active",
                value,
                valueSource: "provided",
                index,
            });
            continue;
        }
        if (
            source === "default" &&
            appearance.metadata.defaults &&
            shouldDisplayDefaultToken(definition, value)
        ) {
            items.push({ name, definition, state: "active", value, valueSource: "default", index });
            continue;
        }
        if (hasNamedFlag && isPositionalArgument(definition)) {
            continue;
        }
        if (definition.required === true) {
            items.push({ name, definition, state: "required", index });
        } else {
            items.push({ name, definition, state: "available", index });
        }
    }

    return items;
}

function inlineHelpLabel(name: string, definition: ArgumentDefinition): string {
    if (isPositionalArgument(definition)) {
        return name;
    }
    return formatArgumentFlagName(name, definition);
}

function helperTypeSuffix(
    definition: ArgumentDefinition,
    appearance: ResolvedInlineHelpAppearance,
): string | undefined {
    if (!appearance.metadata.types) {
        return undefined;
    }
    return `${appearance.format.typeSeparator}${argumentTypeHint(definition)}`;
}

function helperRequiredMarker(
    definition: ArgumentDefinition,
    appearance: ResolvedInlineHelpAppearance,
): string {
    if (!appearance.metadata.required || definition.required !== true) {
        return "";
    }
    return "!";
}

function helperAliasesMetadata(name: string, definition: ArgumentDefinition): string | undefined {
    if (isPositionalArgument(definition)) {
        return undefined;
    }
    const aliases = argumentFlagNames(name, definition)
        .slice(1)
        .map((alias) => `--${alias}`);
    if (aliases.length === 0) {
        return undefined;
    }
    return `aliases ${aliases.join(",")}`;
}

function helperDefaultMetadata(definition: ArgumentDefinition): string | undefined {
    if (definition.default === undefined) {
        return undefined;
    }
    return `default ${formatHelperValue(definition.default)}`;
}

function renderInlineMetadata(parts: string[]): string {
    if (parts.length === 0) {
        return "";
    }
    return ` (${parts.join(", ")})`;
}

function inlineTokenSegments(
    beforeType: string,
    typeSuffix?: string,
    afterType = "",
): InlineTokenCoreSegments {
    return { beforeType, typeSuffix, afterType };
}

function inlineTokenCoreSegments(
    item: InlineHelpItem,
    appearance: ResolvedInlineHelpAppearance,
): InlineTokenCoreSegments {
    if (item.valueSource === "provided") {
        if (!appearance.metadata.types && !appearance.metadata.required) {
            return inlineTokenSegments(
                providedHelperToken(
                    item.name,
                    item.definition,
                    item.value,
                    appearance.format.valueSeparator,
                ),
            );
        }
        const label = `${inlineHelpLabel(item.name, item.definition)}${helperRequiredMarker(
            item.definition,
            appearance,
        )}`;
        const typeSuffix = helperTypeSuffix(item.definition, appearance);
        if (item.definition.type === "boolean") {
            if (item.value === true && !appearance.metadata.types) {
                return inlineTokenSegments(label, typeSuffix);
            }
            return inlineTokenSegments(
                label,
                typeSuffix,
                `${appearance.format.valueSeparator}${formatHelperValue(item.value)}`,
            );
        }
        return inlineTokenSegments(
            label,
            typeSuffix,
            `${appearance.format.valueSeparator}${formatHelperValue(item.value)}`,
        );
    }

    if (item.valueSource === "default") {
        if (!appearance.metadata.types && !appearance.metadata.required) {
            return inlineTokenSegments(
                defaultHelperToken(
                    item.name,
                    item.definition,
                    item.value,
                    appearance.format.valueSeparator,
                ),
            );
        }
        const label = `${inlineHelpLabel(item.name, item.definition)}${helperRequiredMarker(
            item.definition,
            appearance,
        )}`;
        return inlineTokenSegments(
            label,
            helperTypeSuffix(item.definition, appearance),
            `${appearance.format.valueSeparator}${formatHelperValue(item.value)}`,
        );
    }

    if (!appearance.metadata.types && !appearance.metadata.required) {
        return inlineTokenSegments(helperAvailableToken(item.name, item.definition, appearance));
    }

    const label = `${inlineHelpLabel(item.name, item.definition)}${helperRequiredMarker(
        item.definition,
        appearance,
    )}`;
    const typeSuffix = helperTypeSuffix(item.definition, appearance);
    if (isPositionalArgument(item.definition) || item.definition.type === "boolean") {
        return inlineTokenSegments(label, typeSuffix);
    }
    return inlineTokenSegments(
        label,
        typeSuffix,
        ` <${helperValueHint(item.name, item.definition, appearance)}>`,
    );
}

function renderColoredPart(theme: HelperTheme, color: string, text: string): string {
    if (text.length === 0) {
        return "";
    }
    return theme.fg(color, text);
}

function renderInlineHelpToken(
    item: InlineHelpItem,
    theme: HelperTheme,
    appearance: ResolvedInlineHelpAppearance,
): string {
    const metadataParts: string[] = [];
    if (
        appearance.metadata.defaults &&
        appearance.metadata.types &&
        item.valueSource !== "default"
    ) {
        const defaultMetadata = helperDefaultMetadata(item.definition);
        if (defaultMetadata !== undefined) {
            metadataParts.push(defaultMetadata);
        }
    }
    if (appearance.metadata.aliases) {
        const aliases = helperAliasesMetadata(item.name, item.definition);
        if (aliases !== undefined) {
            metadataParts.push(aliases);
        }
    }
    if (appearance.metadata.descriptions && item.definition.description !== undefined) {
        metadataParts.push(item.definition.description);
    }

    const metadata = renderInlineMetadata(metadataParts);
    let renderedMetadata = "";
    if (metadata.length > 0) {
        renderedMetadata = theme.fg(appearance.colors.metadata, metadata);
    }
    const segments = inlineTokenCoreSegments(item, appearance);
    const stateColor = appearance.colors[item.state];
    return (
        renderColoredPart(theme, stateColor, appearance.format.tokenPrefix + segments.beforeType) +
        renderColoredPart(theme, appearance.colors.type, segments.typeSuffix ?? "") +
        renderColoredPart(theme, stateColor, segments.afterType) +
        renderedMetadata +
        renderColoredPart(theme, stateColor, appearance.format.tokenSuffix)
    );
}

function orderGroups(order: InlineHelpOrder): InlineHelpDisplayState[] {
    switch (order) {
        case "active-required-available":
        case "definition":
            return ["active", "required", "available"];
        case "active-available-required":
            return ["active", "available", "required"];
        case "required-active-available":
            return ["required", "active", "available"];
        case "required-available-active":
            return ["required", "available", "active"];
        case "available-active-required":
            return ["available", "active", "required"];
        case "available-required-active":
            return ["available", "required", "active"];
        default:
            return casesHandled(order);
    }
}

function orderedInlineHelpItems(
    items: InlineHelpItem[],
    appearance: ResolvedInlineHelpAppearance,
): InlineHelpItem[][] {
    if (appearance.order === "definition") {
        return [[...items].sort((left, right) => left.index - right.index)];
    }

    const groups: InlineHelpItem[][] = [];
    for (const state of orderGroups(appearance.order)) {
        const group = items.filter((item) => item.state === state);
        if (group.length > 0) {
            groups.push(group);
        }
    }
    return groups;
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
    state: HelperRenderState,
): boolean {
    if (editorTextForInvocation(invocation) === state.submittedInvalidEditorText) {
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

function inlineIssueLine(
    invocation: EditorTypedCommandInvocation,
    state: HelperRenderState,
): string | undefined {
    const parsed = parseTypedCommandArgs(invocation.command, invocation.rawArgs);
    const issue = parsed.issues.find(
        (item) =>
            item.kind !== "missing-required" && shouldShowInlineIssue(invocation, item, state),
    );
    if (issue === undefined) {
        return undefined;
    }
    return `✕ ${formatInlineIssueMessage(invocation, issue)}`;
}

type HelperTheme = {
    fg(color: string, text: string): string;
};

function renderCompactInlineHelper(
    invocation: EditorTypedCommandInvocation,
    width: number,
    theme: HelperTheme,
    state: HelperRenderState,
    appearance: ResolvedInlineHelpAppearance,
): string[] {
    const commandPrefix = `/${commandDisplayName(invocation.command)}`;
    const helperIndent = " ".repeat(commandPrefix.length + 2);
    const items = collectInlineHelperItems(invocation, appearance);
    const tokenGroups = orderedInlineHelpItems(items, appearance).map((group) =>
        group
            .map((item) => renderInlineHelpToken(item, theme, appearance))
            .join(appearance.format.itemSeparator),
    );
    const commandLine = `${helperIndent}${tokenGroups.join(appearance.format.groupSeparator)}`;
    const rendered = [truncateToWidth(commandLine, width, "")];
    const issueLine = inlineIssueLine(invocation, state);
    if (issueLine !== undefined) {
        rendered.push(
            truncateToWidth(
                `${helperIndent}${theme.fg(appearance.colors.issue, issueLine)}`,
                width,
                "",
            ),
        );
    }
    return rendered;
}

/** Render the inline typed-command helper as TUI lines for the current editor invocation. */
export function renderInlineHelper(
    invocation: EditorTypedCommandInvocation,
    width: number,
    theme: HelperTheme,
    state: HelperRenderState = {},
    appearance: ResolvedInlineHelpAppearance = DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.inlineHelp,
): string[] {
    switch (appearance.layout) {
        case "compact":
            return renderCompactInlineHelper(invocation, width, theme, state, appearance);
        default:
            return casesHandled(appearance.layout);
    }
}

/** Set or clear the Pi helper widget for one extension context. */
export function setHelperWidget(
    ctx: ExtensionContext,
    invocation: EditorTypedCommandInvocation | undefined,
    placement: WidgetPlacement,
    state: HelperRenderState = {},
    appearance: ResolvedInlineHelpAppearance = DEFAULT_PI_TYPED_COMMANDS_APPEARANCE.inlineHelp,
): void {
    if (invocation === undefined) {
        ctx.ui.setWidget(WIDGET_KEY, undefined, { placement });
        return;
    }

    ctx.ui.setWidget(
        WIDGET_KEY,
        (_tui, theme) => ({
            render(width: number): string[] {
                return renderInlineHelper(invocation, width, theme, state, appearance);
            },
            invalidate(): void {},
        }),
        { placement },
    );
}
