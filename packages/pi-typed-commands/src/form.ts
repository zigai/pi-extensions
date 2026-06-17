import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
    CURSOR_MARKER,
    decodeKittyPrintable,
    Editor,
    Input,
    matchesKey,
    truncateToWidth,
    visibleWidth,
    type Component,
    type Focusable,
    type SelectListTheme,
    type TUI,
} from "@earendil-works/pi-tui";
import { formatFlagName, toKebabCase } from "./names.js";
import {
    applyArgumentDefault,
    coerceArgumentValue,
    normalizeTextArgumentInput,
    selectableArgumentValues,
    validateArgumentValue,
} from "./schema.js";
import type {
    ArgumentDefinition,
    ArgumentValue,
    ParsedCommandArguments,
    ParseIssue,
    RegisteredTypedCommand,
    TypedCommandFormSymbols,
    FormMode,
} from "./types.js";
import { formatIssues } from "./usage.js";

const UNSET_OPTION = "";

type FormState = Record<string, ArgumentValue>;

type FormTheme = {
    bold(text: string): string;
    fg(color: string, text: string): string;
};

type TextEditorTheme = {
    borderColor: (str: string) => string;
    selectList: SelectListTheme;
};

type FormResult = {
    confirmed: boolean;
    state: FormState;
};

type FormField = {
    name: string;
    definition: ArgumentDefinition;
    issueMessages: string[];
};

type InputCursorState = {
    cursor?: unknown;
};

const LEFT_PADDING = 1;
const FIELD_GAP = 1;
const MIN_VALUE_WIDTH = 12;
const MAX_VALUE_WIDTH = 32;
const NAME_WIDTH = 12;
const FORM_MESSAGE_OPTIONS = { nameStyle: "field" } as const;

function formatFormIssueMessage(issue: ParseIssue): string {
    if (issue.name === undefined) {
        return issue.message;
    }

    return issue.message.replaceAll(formatFlagName(issue.name), toKebabCase(issue.name));
}

function issuesByName(parsed: ParsedCommandArguments): Map<string, string[]> {
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

function issueNames(parsed: ParsedCommandArguments): Set<string> {
    return new Set(issuesByName(parsed).keys());
}

function shouldPromptArgument(
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

function currentValueText(value: ArgumentValue): string {
    if (value === undefined) {
        return "";
    }
    return String(value);
}

function inputCursor(input: Input): number {
    const cursor = (input as unknown as InputCursorState).cursor;
    if (typeof cursor === "number") {
        return cursor;
    }
    return input.getValue().length;
}

function setInputCursor(input: Input, cursor: number): void {
    const boundedCursor = Math.max(0, Math.min(cursor, input.getValue().length));
    (input as unknown as { cursor: number }).cursor = boundedCursor;
}

function numberAllowsNegative(definition: ArgumentDefinition): boolean {
    return definition.type === "number" && (definition.min === undefined || definition.min < 0);
}

function numberInputPrefixIsValid(definition: ArgumentDefinition, value: string): boolean {
    if (definition.type !== "number") {
        return true;
    }
    if (value.length === 0) {
        return true;
    }

    let signPattern = "\\+?";
    if (numberAllowsNegative(definition)) {
        signPattern = "[+-]?";
    }
    if (definition.integer === true) {
        return new RegExp(`^${signPattern}\\d*$`).test(value);
    }
    return new RegExp(`^${signPattern}(?:\\d+|\\d*\\.\\d*)?$`).test(value);
}

function printableInputText(data: string): string | undefined {
    const kittyPrintable = decodeKittyPrintable(data);
    if (kittyPrintable !== undefined) {
        return kittyPrintable;
    }

    let hasControlChars = false;
    for (const char of data) {
        const code = char.charCodeAt(0);
        if (code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
            hasControlChars = true;
            break;
        }
    }
    if (hasControlChars) {
        return undefined;
    }
    return data;
}

function filterNumberInputData(
    definition: ArgumentDefinition,
    value: string,
    cursor: number,
    data: string,
): string | undefined {
    if (definition.type !== "number") {
        return data;
    }

    const printable = printableInputText(data);
    if (printable === undefined) {
        return undefined;
    }

    let nextValue = value;
    let nextCursor = cursor;
    let accepted = "";
    for (const char of printable) {
        const candidate = nextValue.slice(0, nextCursor) + char + nextValue.slice(nextCursor);
        if (!numberInputPrefixIsValid(definition, candidate)) {
            continue;
        }
        accepted += char;
        nextValue = candidate;
        nextCursor += char.length;
    }
    return accepted;
}

class SequentialArgumentForm<TDefinitions extends Record<string, ArgumentDefinition>> {
    private readonly command: RegisteredTypedCommand<TDefinitions>;
    private readonly parsed: ParsedCommandArguments;
    private readonly mode: FormMode;
    private readonly ctx: ExtensionCommandContext;
    private readonly state: FormState;

    constructor(
        command: RegisteredTypedCommand<TDefinitions>,
        parsed: ParsedCommandArguments,
        mode: FormMode,
        ctx: ExtensionCommandContext,
    ) {
        this.command = command;
        this.parsed = parsed;
        this.mode = mode;
        this.ctx = ctx;
        this.state = { ...parsed.values };
    }

    async run(): Promise<Record<string, ArgumentValue> | undefined> {
        if (this.parsed.issues.length > 0) {
            this.ctx.ui.notify(
                formatIssues(this.parsed.issues.map(formatFormIssueMessage)),
                "warning",
            );
        }

        for (const [name, definition] of Object.entries(this.command.args)) {
            if (!shouldPromptArgument(name, definition, this.mode, this.parsed)) {
                continue;
            }

            const completed = await this.promptArgument(name, definition);
            if (!completed) {
                return undefined;
            }
        }

        const messages = this.finalIssues();
        if (messages.length > 0) {
            this.ctx.ui.notify(formatIssues(messages), "error");
            return undefined;
        }

        return this.state;
    }

    private async promptArgument(name: string, definition: ArgumentDefinition): Promise<boolean> {
        let completed = await this.promptEnum(name, definition);
        if (!completed) {
            return false;
        }
        completed = await this.promptBoolean(name, definition);
        if (!completed) {
            return false;
        }
        completed = await this.promptMultiEnum(name, definition);
        if (!completed) {
            return false;
        }
        return this.promptStringLike(name, definition);
    }

    private async promptEnum(name: string, definition: ArgumentDefinition): Promise<boolean> {
        if (definition.type !== "enum") {
            return true;
        }

        const options = [...definition.values];
        if (definition.required !== true) {
            options.unshift(UNSET_OPTION);
        }

        const selected = await this.ctx.ui.select(`Set ${formatFlagName(name)}`, options);
        if (selected === undefined) {
            return false;
        }

        if (selected === UNSET_OPTION) {
            this.state[name] = applyArgumentDefault(definition);
            return true;
        }

        this.state[name] = selected;
        return true;
    }

    private async promptBoolean(name: string, definition: ArgumentDefinition): Promise<boolean> {
        if (definition.type !== "boolean") {
            return true;
        }

        const options = ["true", "false"];
        if (definition.required !== true) {
            options.push(UNSET_OPTION);
        }

        const selected = await this.ctx.ui.select(`Set ${formatFlagName(name)}`, options);
        if (selected === undefined) {
            return false;
        }

        if (selected === UNSET_OPTION) {
            this.state[name] = applyArgumentDefault(definition);
            return true;
        }

        this.state[name] = selected === "true";
        return true;
    }

    private async promptMultiEnum(name: string, definition: ArgumentDefinition): Promise<boolean> {
        if (definition.type !== "multi-enum") {
            return true;
        }

        const current = this.state[name];
        let placeholder = definition.placeholder ?? currentValueText(current);
        if (placeholder.length === 0) {
            placeholder = definition.values.join(",");
        }

        const title = `Set ${formatFlagName(name)} (current: ${currentValueText(current)})`;
        const input = await this.ctx.ui.input(title, placeholder);
        if (input === undefined) {
            return false;
        }

        if (input.trim().length === 0) {
            return this.applyEmptyMultiEnumInput(name, definition, current);
        }

        const coerced = coerceArgumentValue(definition, input, name, FORM_MESSAGE_OPTIONS);
        if (!coerced.ok) {
            this.ctx.ui.notify(coerced.issue.message, "error");
            return this.promptMultiEnum(name, definition);
        }

        const validation = validateArgumentValue(
            name,
            definition,
            coerced.value,
            FORM_MESSAGE_OPTIONS,
        );
        if (!validation.ok) {
            this.ctx.ui.notify(validation.message, "error");
            return this.promptMultiEnum(name, definition);
        }

        this.state[name] = coerced.value;
        return true;
    }

    private async promptStringLike(name: string, definition: ArgumentDefinition): Promise<boolean> {
        if (definition.type !== "string" && definition.type !== "number") {
            return true;
        }

        const current = this.state[name];
        const placeholder = definition.placeholder ?? currentValueText(current);

        const title = `Set ${formatFlagName(name)} (current: ${currentValueText(current)})`;
        const input = await this.ctx.ui.input(title, placeholder);
        if (input === undefined) {
            return false;
        }

        if (input.trim().length === 0) {
            return this.applyEmptyTextInput(name, definition, current);
        }

        if (definition.type === "string") {
            const validation = validateArgumentValue(name, definition, input, FORM_MESSAGE_OPTIONS);
            if (!validation.ok) {
                this.ctx.ui.notify(validation.message, "error");
                return this.promptStringLike(name, definition);
            }
            this.state[name] = input;
            return true;
        }

        const numberValue = coerceArgumentValue(definition, input, name, FORM_MESSAGE_OPTIONS);
        if (!numberValue.ok) {
            this.ctx.ui.notify(numberValue.issue.message, "error");
            return this.promptStringLike(name, definition);
        }

        this.state[name] = numberValue.value;
        return true;
    }

    private async applyEmptyMultiEnumInput(
        name: string,
        definition: ArgumentDefinition,
        current: ArgumentValue,
    ): Promise<boolean> {
        if (current !== undefined) {
            return true;
        }
        const defaultValue = applyArgumentDefault(definition);
        if (defaultValue !== undefined) {
            this.state[name] = defaultValue;
            return true;
        }
        if (definition.required === true) {
            this.ctx.ui.notify(`${toKebabCase(name)} is required`, "error");
            return this.promptMultiEnum(name, definition);
        }
        this.state[name] = undefined;
        return true;
    }

    private async applyEmptyTextInput(
        name: string,
        definition: ArgumentDefinition,
        current: ArgumentValue,
    ): Promise<boolean> {
        if (current !== undefined) {
            return true;
        }
        const defaultValue = applyArgumentDefault(definition);
        if (defaultValue !== undefined) {
            this.state[name] = defaultValue;
            return true;
        }
        if (definition.required === true) {
            this.ctx.ui.notify(`${toKebabCase(name)} is required`, "error");
            return this.promptStringLike(name, definition);
        }
        this.state[name] = undefined;
        return true;
    }

    private finalIssues(): string[] {
        const messages: string[] = [];
        for (const [name, definition] of Object.entries(this.command.args)) {
            const validation = validateArgumentValue(
                name,
                definition,
                this.state[name],
                FORM_MESSAGE_OPTIONS,
            );
            if (!validation.ok) {
                messages.push(validation.message);
            }
        }
        return messages;
    }
}

function widgetFor(definition: ArgumentDefinition): string {
    if (definition.ui?.widget !== undefined) {
        return definition.ui.widget;
    }
    if (definition.type === "boolean") {
        return "toggle";
    }
    if (definition.type === "enum") {
        return "select";
    }
    if (definition.type === "multi-enum") {
        return "multiselect";
    }
    return definition.type;
}

function isTextWidget(definition: ArgumentDefinition): boolean {
    const widget = widgetFor(definition);
    return ["text", "textarea", "number", "path", "command"].includes(widget);
}

function isTextareaWidget(definition: ArgumentDefinition): boolean {
    const widget = widgetFor(definition);
    return widget === "textarea" || widget === "command";
}

function isExpandedOptionsWidget(definition: ArgumentDefinition): boolean {
    const widget = widgetFor(definition);
    return widget === "radio" || widget === "multiselect";
}

function formatValue(value: ArgumentValue): string {
    if (value === undefined) {
        return UNSET_OPTION;
    }
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return UNSET_OPTION;
        }
        return value.join(", ");
    }
    return String(value);
}

function paddedCell(text: string, width: number): string {
    const truncated = truncateToWidth(text, width, "…");
    const padding = Math.max(0, width - visibleWidth(truncated));
    return truncated + " ".repeat(padding);
}

function calculateValueWidth(width: number): number {
    const available = width - LEFT_PADDING - NAME_WIDTH - FIELD_GAP * 3 - 6;
    if (available < MIN_VALUE_WIDTH) {
        return MIN_VALUE_WIDTH;
    }
    return Math.min(MAX_VALUE_WIDTH, available);
}

function valueIndex(values: ArgumentValue[], current: ArgumentValue): number {
    const index = values.findIndex((value) => value === current);
    if (index >= 0) {
        return index;
    }
    return 0;
}

function stepValue(
    definition: ArgumentDefinition,
    current: ArgumentValue,
    direction: number,
): ArgumentValue {
    const values = selectableArgumentValues(definition);
    if (values.length === 0) {
        return current;
    }

    const nextIndex = (valueIndex(values, current) + direction + values.length) % values.length;
    return values[nextIndex];
}

function createEditorTheme(theme: FormTheme): TextEditorTheme {
    const selectList = {
        selectedPrefix: (text: string) => theme.fg("accent", text),
        selectedText: (text: string) => theme.fg("accent", text),
        description: (text: string) => theme.fg("muted", text),
        scrollInfo: (text: string) => theme.fg("dim", text),
        noMatch: (text: string) => theme.fg("warning", text),
    };
    return {
        borderColor: (text: string) => theme.fg("accent", text),
        selectList,
    };
}

function setInputValueAtEnd(input: Input, value: string): void {
    input.setValue(value);
    // pi-tui Input#setValue preserves the previous cursor, so seeding a default value from
    // an empty field would leave the cursor before the text. The component does not expose a
    // cursor setter, but the cursor is TypeScript-private rather than a runtime private field.
    (input as unknown as { cursor: number }).cursor = value.length;
}

class ArgumentFormComponent implements Component, Focusable {
    private selectedIndex = 0;
    private input = new Input();
    private editor: Editor;
    private multiCursorByName = new Map<string, number>();
    private localIssues = new Map<string, string>();
    private readonly fields: FormField[];
    private readonly state: FormState;
    private readonly title: string;
    private readonly theme: FormTheme;
    private readonly symbols: Required<TypedCommandFormSymbols>;
    private readonly done: (result: FormResult | undefined) => void;

    private _focused = false;
    get focused(): boolean {
        return this._focused;
    }
    set focused(value: boolean) {
        this._focused = value;
        this.input.focused = value;
        this.editor.focused = value;
    }

    constructor(
        tui: TUI,
        title: string,
        fields: FormField[],
        state: FormState,
        theme: FormTheme,
        symbols: Required<TypedCommandFormSymbols>,
        done: (result: FormResult | undefined) => void,
        selectedIndex = 0,
    ) {
        this.title = title;
        this.fields = fields;
        this.state = state;
        this.theme = theme;
        this.symbols = symbols;
        this.done = done;
        this.selectedIndex = selectedIndex;
        this.editor = new Editor(tui, createEditorTheme(theme), { autocompleteMaxVisible: 6 });
        this.editor.disableSubmit = true;
        this.input.onSubmit = () => {
            this.submit();
        };
        this.input.onEscape = () => {
            this.done(undefined);
        };
        this.editor.onSubmit = () => {
            this.submit();
        };
        this.syncInputFromState();
    }

    invalidate(): void {
        this.input.invalidate();
        this.editor.invalidate();
    }

    handleInput(data: string): void {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
            this.done(undefined);
            return;
        }
        if (matchesKey(data, "up")) {
            this.moveSelection(-1);
            return;
        }
        if (matchesKey(data, "down")) {
            this.moveSelection(1);
            return;
        }
        if (matchesKey(data, "tab")) {
            this.moveSelection(1);
            return;
        }
        if (matchesKey(data, "shift+tab")) {
            this.moveSelection(-1);
            return;
        }
        if (matchesKey(data, "return")) {
            this.submit();
            return;
        }

        const field = this.selectedField();
        if (this.handleCustomInput(field, data)) {
            return;
        }

        if (field.definition.type === "multi-enum") {
            if (matchesKey(data, "left")) {
                this.moveMultiCursor(field, -1);
                return;
            }
            if (matchesKey(data, "right")) {
                this.moveMultiCursor(field, 1);
                return;
            }
            if (matchesKey(data, "space")) {
                this.toggleMultiValue(field);
                return;
            }
        }

        if (field.definition.type === "boolean" || field.definition.type === "enum") {
            if (matchesKey(data, "left")) {
                this.setCurrentValue(stepValue(field.definition, this.state[field.name], -1));
                return;
            }
            if (matchesKey(data, "right") || matchesKey(data, "space")) {
                this.setCurrentValue(stepValue(field.definition, this.state[field.name], 1));
                return;
            }
        }

        if (isTextareaWidget(field.definition)) {
            this.editor.handleInput(data);
            this.commitInput(false);
            return;
        }

        if (isTextWidget(field.definition)) {
            this.handleTextInput(field, data);
        }
    }

    private handleTextInput(field: FormField, data: string): void {
        if (field.definition.type !== "number") {
            this.input.handleInput(data);
            this.commitInput(false);
            return;
        }

        const previousValue = this.input.getValue();
        const previousCursor = inputCursor(this.input);
        const filteredData = filterNumberInputData(
            field.definition,
            previousValue,
            previousCursor,
            data,
        );
        if (filteredData !== undefined) {
            if (filteredData.length > 0) {
                this.input.handleInput(filteredData);
            }
            this.commitInput(false);
            return;
        }

        this.input.handleInput(data);
        if (!numberInputPrefixIsValid(field.definition, this.input.getValue())) {
            this.input.setValue(previousValue);
            setInputCursor(this.input, previousCursor);
        }
        this.commitInput(false);
    }

    render(width: number): string[] {
        const valueWidth = calculateValueWidth(width);
        const lines: string[] = [];
        lines.push(this.renderHeader(width));
        lines.push("");

        for (let index = 0; index < this.fields.length; index += 1) {
            lines.push(...this.renderField(index, width, valueWidth));
        }

        const selectedIssue = this.currentIssue();
        if (selectedIssue !== undefined) {
            lines.push("");
            lines.push(this.fitLine(this.theme.fg("warning", selectedIssue), width));
        }

        lines.push("");
        lines.push(
            this.fitLine(
                this.theme.fg("dim", "enter submit · ↑↓/tab move · ←/→/space cycle · esc cancel"),
                width,
            ),
        );
        return lines;
    }

    private renderHeader(width: number): string {
        return this.fitLine(this.theme.fg("accent", this.theme.bold(this.title)), width);
    }

    private renderField(index: number, width: number, valueWidth: number): string[] {
        const field = this.fields[index];
        if (field === undefined) {
            return [""];
        }

        const selected = index === this.selectedIndex;
        const marker = this.fieldMarker(selected);
        const name = paddedCell(toKebabCase(field.name), NAME_WIDTH);
        const prefix = " ".repeat(LEFT_PADDING) + marker + " ";

        if (isExpandedOptionsWidget(field.definition)) {
            return this.renderExpandedField(prefix, name, field, selected, width, valueWidth);
        }

        const value = this.renderFieldValue(field, selected, valueWidth);
        const base = prefix + name + " ".repeat(FIELD_GAP) + value;
        const lines = [this.renderInlineFieldLine(base, field, width)];

        if (selected && isTextareaWidget(field.definition)) {
            const editorWidth = Math.max(20, width - LEFT_PADDING - 2);
            const rows = field.definition.ui?.rows ?? 4;
            for (const line of this.editor.render(editorWidth).slice(0, rows)) {
                lines.push(this.fitLine(" ".repeat(LEFT_PADDING + 2) + line, width));
            }
        }

        return lines;
    }

    private renderInlineFieldLine(base: string, field: FormField, width: number): string {
        if (field.definition.description === undefined) {
            return this.fitLine(base, width);
        }

        const separator = " ".repeat(FIELD_GAP);
        const remaining = Math.max(0, width - visibleWidth(base) - visibleWidth(separator));
        const description = truncateToWidth(field.definition.description, remaining, "…");
        return this.fitLine(base + separator + this.theme.fg("dim", description), width);
    }

    private fieldMarker(_selected: boolean): string {
        return " ";
    }

    private renderFieldValue(field: FormField, selected: boolean, width: number): string {
        const customValue = this.renderCustomValue(field, selected, width);
        if (customValue !== undefined) {
            return customValue;
        }

        if (selected && isTextareaWidget(field.definition)) {
            return this.theme.fg("accent", paddedCell(formatValue(this.state[field.name]), width));
        }

        if (selected && isTextWidget(field.definition)) {
            return this.renderSelectedInput(width);
        }

        if (field.definition.type === "boolean") {
            return this.renderBooleanValue(field, selected, width);
        }

        if (field.definition.type === "multi-enum") {
            return this.renderMultiValue(field, selected, width);
        }

        const rawValue = paddedCell(formatValue(this.state[field.name]), width);
        if (selected) {
            return this.theme.fg("accent", rawValue);
        }
        if (this.state[field.name] === undefined) {
            return this.theme.fg("muted", rawValue);
        }
        return rawValue;
    }

    private renderCustomValue(
        field: FormField,
        selected: boolean,
        width: number,
    ): string | undefined {
        const renderValue = field.definition.ui?.custom?.renderValue;
        if (renderValue === undefined) {
            return undefined;
        }

        const rendered = renderValue({
            name: field.name,
            definition: field.definition,
            value: this.state[field.name],
            selected,
            width,
            theme: this.theme,
            formatValue,
        });
        return paddedCell(rendered, width);
    }

    private handleCustomInput(field: FormField, data: string): boolean {
        const handleInput = field.definition.ui?.custom?.handleInput;
        if (handleInput === undefined) {
            return false;
        }

        const result = handleInput({
            name: field.name,
            definition: field.definition,
            value: this.state[field.name],
            data,
            setValue: (value) => {
                this.state[field.name] = value;
                this.localIssues.delete(field.name);
            },
        });
        return result === true;
    }

    private renderBooleanValue(field: FormField, selected: boolean, width: number): string {
        let checkbox = this.symbols.unselectedCheckbox;
        if (this.state[field.name] === true) {
            checkbox = this.symbols.selectedCheckbox;
        }
        const rawValue = paddedCell(checkbox, width);
        if (selected) {
            return this.theme.fg("accent", rawValue);
        }
        return rawValue;
    }

    private renderMultiValue(field: FormField, selected: boolean, width: number): string {
        if (field.definition.type !== "multi-enum") {
            return paddedCell(formatValue(this.state[field.name]), width);
        }

        let currentValues: string[] = [];
        if (Array.isArray(this.state[field.name])) {
            currentValues = this.state[field.name] as string[];
        }
        const selectedValues = new Set(currentValues);
        const cursor = this.multiCursorByName.get(field.name) ?? 0;
        const parts = field.definition.values.map((value, index) => {
            let checkbox = this.symbols.unselectedCheckbox;
            if (selectedValues.has(value)) {
                checkbox = this.symbols.selectedCheckbox;
            }
            const text = `${checkbox} ${value}`;
            if (selected && index === cursor) {
                return this.theme.fg("accent", text);
            }
            return text;
        });
        return paddedCell(parts.join(" "), width);
    }

    private renderExpandedField(
        prefix: string,
        name: string,
        field: FormField,
        selected: boolean,
        width: number,
        valueWidth: number,
    ): string[] {
        const parts = this.optionParts(field, selected);
        const optionsText = parts.join("  ");
        const fieldPrefix = prefix + name + " ".repeat(FIELD_GAP);
        if (visibleWidth(optionsText) <= valueWidth) {
            const base = fieldPrefix + paddedCell(optionsText, valueWidth);
            return [this.renderInlineFieldLine(base, field, width)];
        }

        const base = fieldPrefix + paddedCell("", valueWidth);
        const lines = [this.renderInlineFieldLine(base, field, width)];
        const optionPrefix = " ".repeat(LEFT_PADDING + 2 + NAME_WIDTH + FIELD_GAP);
        for (const part of parts) {
            lines.push(this.fitLine(optionPrefix + part, width));
        }
        return lines;
    }

    private optionParts(field: FormField, selected: boolean): string[] {
        if (field.definition.type === "enum") {
            return this.enumOptionParts(field, selected);
        }
        if (field.definition.type === "multi-enum") {
            return this.multiOptionParts(field, selected);
        }
        return [];
    }

    private enumOptionParts(field: FormField, selected: boolean): string[] {
        if (field.definition.type !== "enum") {
            return [];
        }

        const parts = field.definition.values.map((value) => {
            let radio = this.symbols.unselectedRadio;
            if (this.state[field.name] === value) {
                radio = this.symbols.selectedRadio;
            }
            let text = `${radio} ${value}`;
            if (selected && this.state[field.name] === value) {
                text = this.theme.fg("accent", text);
            }
            return text;
        });
        return parts;
    }

    private multiOptionParts(field: FormField, selected: boolean): string[] {
        if (field.definition.type !== "multi-enum") {
            return [];
        }

        let currentValues: string[] = [];
        if (Array.isArray(this.state[field.name])) {
            currentValues = this.state[field.name] as string[];
        }
        const selectedValues = new Set(currentValues);
        const cursor = this.multiCursorByName.get(field.name) ?? 0;
        const parts = field.definition.values.map((value, index) => {
            let checkbox = this.symbols.unselectedCheckbox;
            if (selectedValues.has(value)) {
                checkbox = this.symbols.selectedCheckbox;
            }
            let text = `${checkbox} ${value}`;
            if (selected && index === cursor) {
                text = this.theme.fg("accent", text);
            }
            return text;
        });
        return parts;
    }

    private renderSelectedInput(width: number): string {
        const rendered = this.input.render(width + 2)[0] ?? "";
        let cell = rendered;
        if (cell.startsWith("> ")) {
            cell = cell.slice(2);
        }
        const withCursor = cell.includes(CURSOR_MARKER);
        if (!withCursor) {
            cell += CURSOR_MARKER;
        }
        const padding = Math.max(0, width - visibleWidth(cell));
        return this.theme.fg("accent", cell + " ".repeat(padding));
    }

    private fitLine(line: string, width: number): string {
        return truncateToWidth(line, width, "");
    }

    private currentIssue(): string | undefined {
        const field = this.selectedField();
        const localIssue = this.localIssues.get(field.name);
        if (localIssue !== undefined) {
            return localIssue;
        }
        const validation = validateArgumentValue(
            field.name,
            field.definition,
            this.state[field.name],
            FORM_MESSAGE_OPTIONS,
        );
        if (!validation.ok) {
            return validation.message;
        }
        return field.issueMessages[0];
    }

    private selectedField(): FormField {
        const field = this.fields[this.selectedIndex];
        if (field !== undefined) {
            return field;
        }
        const first = this.fields[0];
        if (first === undefined) {
            throw new Error("Argument form has no fields");
        }
        return first;
    }

    private moveSelection(delta: number): void {
        if (!this.commitInput(true)) {
            return;
        }
        this.selectedIndex = (this.selectedIndex + delta + this.fields.length) % this.fields.length;
        this.syncInputFromState();
    }

    private setCurrentValue(value: ArgumentValue): void {
        const field = this.selectedField();
        this.state[field.name] = value;
        this.localIssues.delete(field.name);
    }

    private commitInput(strict: boolean): boolean {
        const field = this.selectedField();
        if (!isTextWidget(field.definition)) {
            return true;
        }

        let rawValue = this.input.getValue();
        if (isTextareaWidget(field.definition)) {
            rawValue = this.editor.getText();
        }
        const value = normalizeTextArgumentInput(field.definition, rawValue);
        const validation = validateArgumentValue(
            field.name,
            field.definition,
            value,
            FORM_MESSAGE_OPTIONS,
        );
        if (!validation.ok) {
            if (validation.message !== undefined) {
                this.localIssues.set(field.name, validation.message);
            }
            return !strict;
        }

        this.state[field.name] = value;
        this.localIssues.delete(field.name);
        return true;
    }

    private moveMultiCursor(field: FormField, delta: number): void {
        if (field.definition.type !== "multi-enum") {
            return;
        }
        const current = this.multiCursorByName.get(field.name) ?? 0;
        const next =
            (current + delta + field.definition.values.length) % field.definition.values.length;
        this.multiCursorByName.set(field.name, next);
    }

    private toggleMultiValue(field: FormField): void {
        if (field.definition.type !== "multi-enum") {
            return;
        }
        const cursor = this.multiCursorByName.get(field.name) ?? 0;
        const value = field.definition.values[cursor];
        if (value === undefined) {
            return;
        }
        let current: string[] = [];
        if (Array.isArray(this.state[field.name])) {
            current = [...(this.state[field.name] as string[])];
        }
        const existingIndex = current.indexOf(value);
        if (existingIndex >= 0) {
            current.splice(existingIndex, 1);
        } else {
            current.push(value);
        }
        this.state[field.name] = current;
        this.localIssues.delete(field.name);
    }

    private syncInputFromState(): void {
        const field = this.selectedField();
        if (!isTextWidget(field.definition)) {
            setInputValueAtEnd(this.input, "");
            this.editor.setText("");
            return;
        }

        const value = this.state[field.name];
        let text = "";
        if (value !== undefined) {
            text = String(value);
        }
        if (isTextareaWidget(field.definition)) {
            this.editor.setText(text);
            setInputValueAtEnd(this.input, "");
            return;
        }
        setInputValueAtEnd(this.input, text);
        this.editor.setText("");
    }

    private submit(): void {
        if (!this.commitInput(true)) {
            return;
        }

        const messages: string[] = [];
        for (const field of this.fields) {
            const validation = validateArgumentValue(
                field.name,
                field.definition,
                this.state[field.name],
                FORM_MESSAGE_OPTIONS,
            );
            if (validation.ok) {
                continue;
            }
            messages.push(validation.message);
            this.localIssues.set(field.name, validation.message);
        }

        if (messages.length > 0) {
            const firstInvalidIndex = this.fields.findIndex((field) =>
                this.localIssues.has(field.name),
            );
            if (firstInvalidIndex >= 0) {
                this.selectedIndex = firstInvalidIndex;
                this.syncInputFromState();
            }
            return;
        }

        this.done({ confirmed: true, state: this.state });
    }
}

function resolveFormTitle<TDefinitions extends Record<string, ArgumentDefinition>>(
    command: RegisteredTypedCommand<TDefinitions>,
    ctx: ExtensionCommandContext,
): string {
    const title = command.formTitle;
    if (typeof title === "function") {
        return title(ctx);
    }
    if (title !== undefined) {
        return title;
    }
    return command.name;
}

async function openDenseArgumentForm<TDefinitions extends Record<string, ArgumentDefinition>>(
    command: RegisteredTypedCommand<TDefinitions>,
    parsed: ParsedCommandArguments,
    mode: FormMode,
    ctx: ExtensionCommandContext,
): Promise<Record<string, ArgumentValue> | undefined> {
    const state: FormState = { ...parsed.values };
    const namedIssues = issuesByName(parsed);
    const fields: FormField[] = [];

    let initialSelection = -1;
    for (const [name, definition] of Object.entries(command.args)) {
        if (initialSelection < 0 && shouldPromptArgument(name, definition, mode, parsed)) {
            initialSelection = fields.length;
        }
        fields.push({
            name,
            definition,
            issueMessages: namedIssues.get(name) ?? [],
        });
    }

    if (fields.length === 0) {
        return state;
    }
    if (initialSelection < 0) {
        initialSelection = 0;
    }

    const result = await ctx.ui.custom<FormResult | undefined>(
        (tui, theme, _keybindings, done) =>
            new ArgumentFormComponent(
                tui,
                resolveFormTitle(command, ctx),
                fields,
                state,
                theme,
                command.formSymbols,
                done,
                initialSelection,
            ),
    );

    if (result === undefined || !result.confirmed) {
        return undefined;
    }

    return result.state;
}

export async function openArgumentForm<TDefinitions extends Record<string, ArgumentDefinition>>(
    command: RegisteredTypedCommand<TDefinitions>,
    parsed: ParsedCommandArguments,
    mode: FormMode,
    ctx: ExtensionCommandContext,
): Promise<Record<string, ArgumentValue> | undefined> {
    if (ctx.mode === "tui") {
        return openDenseArgumentForm(command, parsed, mode, ctx);
    }

    return new SequentialArgumentForm(command, parsed, mode, ctx).run();
}
