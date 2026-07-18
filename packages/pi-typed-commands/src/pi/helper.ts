import type { ExtensionContext, WidgetPlacement } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { resolveTypedCommandRoute } from "../command/subcommands.js";
import { casesHandled } from "../exhaustive.js";
import { lexTypedArgumentString, parseTypedCommandArgs, type Token } from "../parser.js";
import {
    argumentFlagNames,
    argumentTypeHint,
    argumentValueHint,
    createArgumentLookup,
    findArgumentName,
    formatArgumentFlagName,
    isPositionalArgument,
    orderedCommandArgumentEntries,
    positionalArgumentEntries,
} from "../schema.js";
import type {
    ArgumentDefinition,
    ArgumentValue,
    EnumArgumentDefinition,
    MultiEnumArgumentDefinition,
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

export type ChoiceArgumentDefinition = EnumArgumentDefinition | MultiEnumArgumentDefinition;

export type ActiveChoiceContext = {
    name: string;
    definition: ChoiceArgumentDefinition;
    query: string;
    replacementStart: number;
    replacementEnd: number;
};

function isChoiceArgumentDefinition(
    definition: ArgumentDefinition,
): definition is ChoiceArgumentDefinition {
    return definition.type === "enum" || definition.type === "multi-enum";
}

function helperValueHint(
    name: string,
    definition: ArgumentDefinition,
    appearance: ResolvedInlineHelpAppearance,
): string {
    if (isChoiceArgumentDefinition(definition) && definition.placeholder === undefined) {
        if (appearance.metadata.enumValues === false) {
            return argumentTypeHint(definition);
        }
        if (appearance.choiceDisplay === "contextual") {
            return "value";
        }
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

function choiceContextForName(
    command: RegisteredTypedCommand,
    name: string,
    query: string,
    replacementStart: number,
    replacementEnd: number,
): ActiveChoiceContext | undefined {
    const definition = command.args[name];
    if (definition === undefined || !isChoiceArgumentDefinition(definition)) {
        return undefined;
    }
    const commaIndex = query.lastIndexOf(",");
    const queryAfterComma = query.slice(commaIndex + 1);
    return {
        name,
        definition,
        query: queryAfterComma,
        replacementStart: replacementStart + commaIndex + 1,
        replacementEnd,
    };
}

function namedChoiceContext(
    command: RegisteredTypedCommand,
    rawArgs: string,
    tokens: readonly Token[],
): ActiveChoiceContext | undefined {
    const lastToken = tokens[tokens.length - 1];
    if (lastToken === undefined) {
        return undefined;
    }

    const endsWithWhitespace = /\s$/.test(rawArgs);
    const lookup = createArgumentLookup(command.args);
    if (lastToken.quote === undefined && lastToken.value.startsWith("-")) {
        const equalsIndex = lastToken.value.indexOf("=");
        if (equalsIndex >= 0) {
            if (endsWithWhitespace) {
                return undefined;
            }
            const name = findArgumentName(lookup, lastToken.value.slice(0, equalsIndex));
            if (name === undefined) {
                return undefined;
            }
            return choiceContextForName(
                command,
                name,
                lastToken.value.slice(equalsIndex + 1),
                lastToken.start + equalsIndex + 1,
                lastToken.end,
            );
        }
        if (endsWithWhitespace) {
            const name = findArgumentName(lookup, lastToken.value);
            if (name !== undefined) {
                return choiceContextForName(command, name, "", rawArgs.length, rawArgs.length);
            }
        }
        return undefined;
    }

    if (endsWithWhitespace) {
        return undefined;
    }
    const previousToken = tokens[tokens.length - 2];
    if (
        previousToken === undefined ||
        previousToken.quote !== undefined ||
        !previousToken.value.startsWith("-") ||
        previousToken.value.includes("=")
    ) {
        return undefined;
    }
    const name = findArgumentName(lookup, previousToken.value);
    if (name === undefined) {
        return undefined;
    }
    return choiceContextForName(command, name, lastToken.value, lastToken.start, lastToken.end);
}

function flagConsumesHelperValue(definition: ArgumentDefinition): boolean {
    switch (definition.type) {
        case "string":
        case "number":
        case "enum":
        case "multi-enum":
        case "string-list":
        case "key-value":
            return true;
        case "boolean":
            return false;
        default:
            return casesHandled(definition);
    }
}

function positionalChoiceContext(
    command: RegisteredTypedCommand,
    rawArgs: string,
    tokens: readonly Token[],
): ActiveChoiceContext | undefined {
    const endsWithWhitespace = /\s$/.test(rawArgs);
    const lookup = createArgumentLookup(command.args);
    if (!endsWithWhitespace && tokens.length > 0) {
        const currentToken = tokens[tokens.length - 1];
        const earlierTokens = tokens.slice(0, -1);
        const optionsEnded = earlierTokens.some(
            (token) => token.quote === undefined && token.value === "--",
        );
        if (
            !optionsEnded &&
            currentToken?.quote === undefined &&
            currentToken?.value.startsWith("-") === true
        ) {
            return undefined;
        }

        const previousToken = tokens[tokens.length - 2];
        if (
            !optionsEnded &&
            previousToken?.quote === undefined &&
            previousToken?.value.startsWith("-") === true &&
            !previousToken.value.includes("=")
        ) {
            const previousName = findArgumentName(lookup, previousToken.value);
            let previousDefinition: ArgumentDefinition | undefined;
            if (previousName !== undefined) {
                previousDefinition = command.args[previousName];
            }
            if (previousDefinition !== undefined && flagConsumesHelperValue(previousDefinition)) {
                return undefined;
            }
        }
    }

    let completedTokenCount = tokens.length;
    let query = "";
    if (!endsWithWhitespace && tokens.length > 0) {
        completedTokenCount -= 1;
        query = tokens[tokens.length - 1]?.value ?? "";
    }
    let positionalIndex = 0;
    let skipNextFlagValue = false;
    let optionsEnded = false;
    for (let index = 0; index < completedTokenCount; index += 1) {
        const token = tokens[index];
        if (token === undefined) {
            continue;
        }
        if (skipNextFlagValue) {
            skipNextFlagValue = false;
            continue;
        }
        if (!optionsEnded && token.quote === undefined && token.value === "--") {
            optionsEnded = true;
            continue;
        }
        if (!optionsEnded && token.quote === undefined && token.value.startsWith("-")) {
            let flag = token.value;
            const equalsIndex = flag.indexOf("=");
            if (equalsIndex >= 0) {
                flag = flag.slice(0, equalsIndex);
            }
            const name = findArgumentName(lookup, flag);
            let definition: ArgumentDefinition | undefined;
            if (name !== undefined) {
                definition = command.args[name];
            }
            if (
                definition !== undefined &&
                flagConsumesHelperValue(definition) &&
                equalsIndex < 0
            ) {
                skipNextFlagValue = true;
            }
            continue;
        }
        positionalIndex += 1;
    }

    const entry = positionalArgumentEntries(command.args)[positionalIndex];
    if (entry === undefined) {
        return undefined;
    }
    let replacementStart = rawArgs.length;
    let replacementEnd = rawArgs.length;
    if (!endsWithWhitespace) {
        const currentToken = tokens[tokens.length - 1];
        if (currentToken !== undefined) {
            replacementStart = currentToken.start;
            replacementEnd = currentToken.end;
        }
    }
    return choiceContextForName(command, entry[0], query, replacementStart, replacementEnd);
}

export function activeChoiceContext(
    invocation: EditorTypedCommandInvocation,
): ActiveChoiceContext | undefined {
    const tokens = lexTypedArgumentString(invocation.rawArgs).tokens;
    return (
        namedChoiceContext(invocation.command, invocation.rawArgs, tokens) ??
        positionalChoiceContext(invocation.command, invocation.rawArgs, tokens)
    );
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
    return Object.entries(value)
        .map(([key, entryValue]) => `${key}=${entryValue}`)
        .join(",");
}

function formatArgumentHelperValue(definition: ArgumentDefinition, value: ArgumentValue): string {
    if (definition.type === "string" && definition.sensitive === true && value !== undefined) {
        return "<redacted>";
    }
    return formatHelperValue(value);
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
    if (definition.type === "string" && definition.sensitive === true) {
        return `${flag}${valueSeparator}<redacted>`;
    }
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
    if (definition.type === "string" && definition.sensitive === true) {
        return `${flag}${valueSeparator}<redacted>`;
    }
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
    return `default ${formatArgumentHelperValue(definition, definition.default)}`;
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
    choiceContext?: ActiveChoiceContext,
): InlineTokenCoreSegments {
    if (choiceContext?.name === item.name && item.value === undefined) {
        const label = `${inlineHelpLabel(item.name, item.definition)}${helperRequiredMarker(
            item.definition,
            appearance,
        )}`;
        return inlineTokenSegments(
            label,
            helperTypeSuffix(item.definition, appearance),
            `${appearance.format.valueSeparator}<${helperValueHint(
                item.name,
                item.definition,
                appearance,
            )}>`,
        );
    }

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
                `${appearance.format.valueSeparator}${formatArgumentHelperValue(item.definition, item.value)}`,
            );
        }
        return inlineTokenSegments(
            label,
            typeSuffix,
            `${appearance.format.valueSeparator}${formatArgumentHelperValue(item.definition, item.value)}`,
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
            `${appearance.format.valueSeparator}${formatArgumentHelperValue(item.definition, item.value)}`,
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
    choiceContext?: ActiveChoiceContext,
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
    const segments = inlineTokenCoreSegments(item, appearance, choiceContext);
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
    choiceContext?: ActiveChoiceContext,
): string | undefined {
    const parsed = parseTypedCommandArgs(invocation.command, invocation.rawArgs);
    const submitted = editorTextForInvocation(invocation) === state.submittedInvalidEditorText;
    const issue = parsed.issues.find((item) => {
        if (item.kind === "missing-required") {
            return false;
        }
        if (!submitted && choiceContext?.name === item.name) {
            return false;
        }
        return shouldShowInlineIssue(invocation, item, state);
    });
    if (issue === undefined) {
        return undefined;
    }
    return `✕ ${formatInlineIssueMessage(invocation, issue)}`;
}

type HelperTheme = {
    fg(color: string, text: string): string;
};

function renderContextualChoiceLines(
    context: ActiveChoiceContext,
    helperIndent: string,
    width: number,
    theme: HelperTheme,
    appearance: ResolvedInlineHelpAppearance,
): string[] {
    const label = bareInlineArgumentLabel(context.name, context.definition);
    const firstPrefix = `${helperIndent}${label}: `;
    const continuationPrefix = " ".repeat(firstPrefix.length);
    const separator = appearance.format.groupSeparator;
    const rows: Array<{ prefix: string; values: string[] }> = [];
    let prefix = firstPrefix;
    let values: string[] = [];
    let rowWidth = prefix.length;

    for (const value of context.definition.values) {
        let separatorWidth = 0;
        if (values.length > 0) {
            separatorWidth = separator.length;
        }
        if (values.length > 0 && rowWidth + separatorWidth + value.length > width) {
            rows.push({ prefix, values });
            prefix = continuationPrefix;
            values = [];
            rowWidth = prefix.length;
        }
        if (values.length > 0) {
            rowWidth += separator.length;
        }
        values.push(value);
        rowWidth += value.length;
    }
    if (values.length > 0) {
        rows.push({ prefix, values });
    }

    return rows.map((row) => {
        const renderedValues = row.values
            .map((value) => {
                let color = appearance.colors.type;
                if (context.query.length > 0 && value.startsWith(context.query)) {
                    color = appearance.colors.active;
                }
                return theme.fg(color, value);
            })
            .join(separator);
        return truncateToWidth(
            `${theme.fg(appearance.colors.active, row.prefix)}${renderedValues}`,
            width,
            "",
        );
    });
}

function renderCompactInlineHelper(
    invocation: EditorTypedCommandInvocation,
    width: number,
    theme: HelperTheme,
    state: HelperRenderState,
    appearance: ResolvedInlineHelpAppearance,
): string[] {
    const commandPrefix = `/${commandDisplayName(invocation.command)}`;
    const helperIndent = " ".repeat(commandPrefix.length + 2);
    const choiceContext = activeChoiceContext(invocation);
    const items = collectInlineHelperItems(invocation, appearance);
    const tokenGroups = orderedInlineHelpItems(items, appearance).map((group) =>
        group
            .map((item) => renderInlineHelpToken(item, theme, appearance, choiceContext))
            .join(appearance.format.itemSeparator),
    );
    const commandLine = `${helperIndent}${tokenGroups.join(appearance.format.groupSeparator)}`;
    let rendered: string[] = [];
    if (commandLine.trim().length > 0) {
        rendered = wrapTextWithAnsi(commandLine, width);
    }
    const formOnlyCount = Object.values(invocation.command.args).filter(
        (definition) => definition.formOnly === true,
    ).length;
    if (formOnlyCount > 0) {
        let fieldSuffix = "s";
        if (formOnlyCount === 1) {
            fieldSuffix = "";
        }
        rendered.push(
            truncateToWidth(
                `${helperIndent}${theme.fg(
                    appearance.colors.metadata,
                    `↳ form: ${formOnlyCount} additional field${fieldSuffix}`,
                )}`,
                width,
                "…",
            ),
        );
    }
    if (
        appearance.choiceDisplay === "contextual" &&
        appearance.metadata.enumValues &&
        choiceContext !== undefined
    ) {
        rendered.push(
            ...renderContextualChoiceLines(choiceContext, helperIndent, width, theme, appearance),
        );
    }
    const issueLine = inlineIssueLine(invocation, state, choiceContext);
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
    if (invocation.command.inlineHelp === "hidden") {
        return [];
    }
    const route = resolveTypedCommandRoute(invocation.command, invocation.rawArgs);
    if (route.status === "subcommand" && route.subcommand !== undefined) {
        const selected = invocation.command.subcommands?.[route.subcommand];
        if (selected !== undefined) {
            return renderInlineHelper(
                {
                    command: selected,
                    rawArgs: route.rawArgs,
                    trailingBody: invocation.trailingBody,
                },
                width,
                theme,
                state,
                appearance,
            );
        }
    }
    if (
        invocation.command.subcommands !== undefined &&
        (route.status === "missing" ||
            route.status === "unknown" ||
            invocation.rawArgs.trim().length === 0)
    ) {
        const commandPrefix = `/${commandDisplayName(invocation.command)}`;
        const indent = " ".repeat(commandPrefix.length + 2);
        const tokens = Object.entries(invocation.command.subcommands).map(([name, subcommand]) => {
            let aliases = "";
            if (appearance.metadata.aliases) {
                let aliasMetadata: string[] = [];
                if ((subcommand.aliases?.length ?? 0) > 0) {
                    aliasMetadata = [`aliases ${subcommand.aliases?.join(",") ?? ""}`];
                }
                aliases = renderInlineMetadata(aliasMetadata);
            }
            return theme.fg(
                appearance.colors.required,
                `${appearance.format.tokenPrefix}${name}${aliases}${appearance.format.tokenSuffix}`,
            );
        });
        const lines = [
            truncateToWidth(`${indent}${tokens.join(appearance.format.itemSeparator)}`, width, "…"),
        ];
        if (route.status === "unknown") {
            lines.push(
                truncateToWidth(
                    `${indent}${theme.fg(
                        appearance.colors.issue,
                        `✕ Unknown subcommand '${route.token ?? ""}'`,
                    )}`,
                    width,
                    "…",
                ),
            );
        }
        return lines;
    }
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
    if (invocation === undefined || invocation.command.inlineHelp === "hidden") {
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
