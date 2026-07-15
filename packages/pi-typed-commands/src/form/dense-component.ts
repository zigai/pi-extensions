import {
    CURSOR_MARKER,
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
import { casesHandled } from "../exhaustive.js";
import { toKebabCase } from "../names.js";
import {
    normalizeTextArgumentInput,
    selectableArgumentValues,
    validateArgumentValue,
} from "../schema.js";
import type { FormField, FormState } from "../pi-tui/form-model.js";
import type { ArgumentDefinition, ArgumentValue, TypedCommandFormSymbols } from "../types.js";
import type { ResolvedFormAppearance, ResolvedFormSymbols } from "../pi/presentation-config.js";
import { FORM_MESSAGE_OPTIONS, UNSET_OPTION } from "./constants.js";
import {
    filterNumberInputData,
    inputCursor,
    restoreNumberInputIfInvalid,
    setInputValueAtEnd,
} from "./input.js";

type FormTheme = {
    bold(text: string): string;
    fg(color: string, text: string): string;
};

type TextEditorTheme = {
    borderColor: (str: string) => string;
    selectList: SelectListTheme;
};

/** Result returned from the dense form component when it is submitted or cancelled. */
export type FormResult = {
    confirmed: boolean;
    state: FormState;
};

function widgetFor(definition: ArgumentDefinition): string {
    if (definition.ui?.widget !== undefined) {
        return definition.ui.widget;
    }
    switch (definition.type) {
        case "string":
        case "number":
            return definition.type;
        case "boolean":
            return "toggle";
        case "enum":
            return "select";
        case "multi-enum":
            return "multiselect";
        default:
            return casesHandled(definition);
    }
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

function evaluateFormBoolean(
    option: boolean | ((values: Readonly<FormState>) => boolean) | undefined,
    state: FormState,
): boolean {
    if (typeof option === "function") {
        return option({ ...state });
    }
    return option === true;
}

function isHiddenField(definition: ArgumentDefinition, state: FormState): boolean {
    return evaluateFormBoolean(definition.ui?.hidden, state);
}

function isReadOnlyWidget(definition: ArgumentDefinition, state: FormState): boolean {
    const widget = widgetFor(definition);
    return (
        widget === "readonly" ||
        widget === "computed" ||
        definition.ui?.compute !== undefined ||
        evaluateFormBoolean(definition.ui?.readOnly, state)
    );
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

function formatInlineValue(value: ArgumentValue): string {
    return formatValue(value).replace(/\r\n|\r|\n/g, " ↵ ");
}

function stringSelections(value: ArgumentValue): readonly string[] {
    if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
        return [];
    }
    return value;
}

function paddedCell(text: string, width: number): string {
    const truncated = truncateToWidth(text, width, "…");
    const padding = Math.max(0, width - visibleWidth(truncated));
    return truncated + " ".repeat(padding);
}

function calculateValueWidth(
    width: number,
    nameWidth: number,
    appearance: ResolvedFormAppearance,
): number {
    const { layout } = appearance;
    const available = width - layout.leftPadding - nameWidth - layout.fieldGap * 3 - 6;
    if (available < layout.minValueWidth) {
        return layout.minValueWidth;
    }
    return Math.min(layout.maxValueWidth, available);
}

function fieldTitle(field: FormField): string {
    return field.definition.title ?? field.definition.ui?.title ?? toKebabCase(field.name);
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

function createEditorTheme(theme: FormTheme, appearance: ResolvedFormAppearance): TextEditorTheme {
    const selectList = {
        selectedPrefix: (text: string) => theme.fg(appearance.colors.selectedOption, text),
        selectedText: (text: string) => theme.fg(appearance.colors.selectedOption, text),
        description: (text: string) => theme.fg(appearance.colors.description, text),
        scrollInfo: (text: string) => theme.fg(appearance.colors.instructions, text),
        noMatch: (text: string) => theme.fg(appearance.colors.issue, text),
    };
    return {
        borderColor: (text: string) => theme.fg(appearance.colors.editorBorder, text),
        selectList,
    };
}

function resolveComponentSymbols(
    commandSymbols: Required<TypedCommandFormSymbols>,
    appearance: ResolvedFormAppearance,
): ResolvedFormSymbols {
    return {
        focusedField: appearance.symbols.focusedField,
        selectedCheckbox:
            appearance.symbolOverrides.selectedCheckbox ?? commandSymbols.selectedCheckbox,
        unselectedCheckbox:
            appearance.symbolOverrides.unselectedCheckbox ?? commandSymbols.unselectedCheckbox,
        selectedRadio: appearance.symbolOverrides.selectedRadio ?? commandSymbols.selectedRadio,
        unselectedRadio:
            appearance.symbolOverrides.unselectedRadio ?? commandSymbols.unselectedRadio,
    };
}

/** Dense TUI component for editing all typed-command arguments in one form. */
export class ArgumentFormComponent implements Component, Focusable {
    private selectedIndex = 0;
    private input = new Input();
    private editor: Editor;
    private multiCursorByName = new Map<string, number>();
    private localIssues = new Map<string, string>();
    private readonly fields: FormField[];
    private readonly state: FormState;
    private readonly title: string;
    private readonly theme: FormTheme;
    private readonly symbols: ResolvedFormSymbols;
    private readonly appearance: ResolvedFormAppearance;
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
        appearance: ResolvedFormAppearance,
        done: (result: FormResult | undefined) => void,
        selectedIndex = 0,
    ) {
        this.title = title;
        this.fields = fields;
        this.state = state;
        this.theme = theme;
        this.appearance = appearance;
        this.symbols = resolveComponentSymbols(symbols, appearance);
        this.done = done;
        this.selectedIndex = selectedIndex;
        this.editor = new Editor(tui, createEditorTheme(theme, appearance), {
            autocompleteMaxVisible: 6,
        });
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
        this.applyComputedValues();
        if (this.handleCustomInput(field, data)) {
            return;
        }
        if (isReadOnlyWidget(field.definition, this.state)) {
            return;
        }

        if (this.handleDiscreteInput(field, data)) {
            return;
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

    private handleDiscreteInput(field: FormField, data: string): boolean {
        switch (field.definition.type) {
            case "string":
            case "number":
                return false;
            case "boolean":
            case "enum":
                if (matchesKey(data, "left")) {
                    this.setCurrentValue(stepValue(field.definition, this.state[field.name], -1));
                    return true;
                }
                if (matchesKey(data, "right") || matchesKey(data, "space")) {
                    this.setCurrentValue(stepValue(field.definition, this.state[field.name], 1));
                    return true;
                }
                return false;
            case "multi-enum":
                if (matchesKey(data, "left")) {
                    this.moveMultiCursor(field, -1);
                    return true;
                }
                if (matchesKey(data, "right")) {
                    this.moveMultiCursor(field, 1);
                    return true;
                }
                if (matchesKey(data, "space")) {
                    this.toggleMultiValue(field);
                    return true;
                }
                return false;
            default:
                return casesHandled(field.definition);
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
        restoreNumberInputIfInvalid(this.input, field.definition, previousValue, previousCursor);
        this.commitInput(false);
    }

    render(width: number): string[] {
        this.applyComputedValues();
        const nameWidth = this.calculateNameWidth(width);
        const valueWidth = calculateValueWidth(width, nameWidth, this.appearance);
        const lines: string[] = [];
        lines.push(this.renderHeader(width));
        lines.push("");

        for (let index = 0; index < this.fields.length; index += 1) {
            lines.push(...this.renderField(index, width, nameWidth, valueWidth));
        }

        const selectedIssue = this.currentIssue();
        if (selectedIssue !== undefined) {
            lines.push("");
            lines.push(
                this.fitLine(this.theme.fg(this.appearance.colors.issue, selectedIssue), width),
            );
        }

        const instructions = this.instructionsText();
        if (instructions !== undefined) {
            lines.push("");
            lines.push(
                this.fitLine(
                    this.theme.fg(this.appearance.colors.instructions, instructions),
                    width,
                ),
            );
        }
        return lines;
    }

    private renderHeader(width: number): string {
        return this.fitLine(
            this.theme.fg(this.appearance.colors.title, this.theme.bold(this.title)),
            width,
        );
    }

    private instructionsText(): string | undefined {
        switch (this.appearance.layout.instructions) {
            case "full":
                return "enter submit · ↑↓/tab move · ←/→/space cycle · esc cancel";
            case "short":
                return "enter submit · tab move · esc cancel";
            case "hidden":
                return undefined;
            default:
                return casesHandled(this.appearance.layout.instructions);
        }
    }

    private calculateNameWidth(width: number): number {
        const { layout } = this.appearance;
        const visibleTitleWidths = this.fields
            .filter((field) => !isHiddenField(field.definition, this.state))
            .map((field) => visibleWidth(fieldTitle(field)));
        const desired = Math.max(layout.minNameWidth, ...visibleTitleWidths);
        const available =
            width - layout.leftPadding - layout.fieldGap * 3 - layout.minValueWidth - 6;
        const maxWidth = Math.max(layout.minNameWidth, Math.min(layout.maxNameWidth, available));
        return Math.min(desired, maxWidth);
    }

    private renderField(
        index: number,
        width: number,
        nameWidth: number,
        valueWidth: number,
    ): string[] {
        const field = this.fields[index];
        if (field === undefined) {
            return [""];
        }
        if (isHiddenField(field.definition, this.state)) {
            return [];
        }

        const selected = index === this.selectedIndex;
        const marker = this.fieldMarker(selected);
        const rawName = paddedCell(fieldTitle(field), nameWidth);
        let name = rawName;
        if (selected) {
            name = this.theme.fg(this.appearance.colors.focusedLabel, rawName);
        }
        const prefix = " ".repeat(this.appearance.layout.leftPadding) + marker + " ";

        if (isExpandedOptionsWidget(field.definition)) {
            return this.renderExpandedField(
                prefix,
                name,
                field,
                selected,
                width,
                nameWidth,
                valueWidth,
            );
        }

        const value = this.renderFieldValue(field, selected, valueWidth);
        const base = prefix + name + " ".repeat(this.appearance.layout.fieldGap) + value;
        const lines = [this.renderInlineFieldLine(base, field, selected, width)];

        if (selected && isTextareaWidget(field.definition)) {
            const editorWidth = Math.max(20, width - this.appearance.layout.leftPadding - 2);
            const rows = field.definition.ui?.rows ?? 4;
            for (const line of this.editor.render(editorWidth).slice(0, rows)) {
                lines.push(
                    this.fitLine(" ".repeat(this.appearance.layout.leftPadding + 2) + line, width),
                );
            }
        }

        return lines;
    }

    private renderInlineFieldLine(
        base: string,
        field: FormField,
        selected: boolean,
        width: number,
    ): string {
        if (field.definition.description === undefined || !this.shouldRenderDescription(selected)) {
            return this.fitLine(base, width);
        }

        const separator = " ".repeat(this.appearance.layout.fieldGap);
        const remaining = Math.max(0, width - visibleWidth(base) - visibleWidth(separator));
        const description = truncateToWidth(field.definition.description, remaining, "…");
        return this.fitLine(
            base + separator + this.theme.fg(this.appearance.colors.description, description),
            width,
        );
    }

    private shouldRenderDescription(selected: boolean): boolean {
        switch (this.appearance.layout.descriptions) {
            case "inline":
                return true;
            case "focused":
                return selected;
            case "hidden":
                return false;
            default:
                return casesHandled(this.appearance.layout.descriptions);
        }
    }

    private fieldMarker(selected: boolean): string {
        if (selected) {
            return this.theme.fg(this.appearance.colors.focusedLabel, this.symbols.focusedField);
        }
        return " ";
    }

    private renderFieldValue(field: FormField, selected: boolean, width: number): string {
        const customValue = this.renderCustomValue(field, selected, width);
        if (customValue !== undefined) {
            return customValue;
        }

        if (selected && isTextareaWidget(field.definition)) {
            return this.theme.fg(this.appearance.colors.focusedValue, paddedCell("", width));
        }

        if (selected && isTextWidget(field.definition)) {
            return this.renderSelectedInput(width);
        }

        switch (field.definition.type) {
            case "boolean":
                return this.renderBooleanValue(field, selected, width);
            case "multi-enum":
                return this.renderMultiValue(field, selected, width);
            case "string":
            case "number":
            case "enum": {
                const rawValue = paddedCell(formatInlineValue(this.state[field.name]), width);
                if (selected) {
                    return this.theme.fg(this.appearance.colors.focusedValue, rawValue);
                }
                if (this.state[field.name] === undefined) {
                    return this.theme.fg(this.appearance.colors.unsetValue, rawValue);
                }
                return rawValue;
            }
            default:
                return casesHandled(field.definition);
        }
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
            values: { ...this.state },
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
            values: { ...this.state },
            data,
            setValue: (value) => {
                this.state[field.name] = value;
                this.localIssues.delete(field.name);
            },
            setValues: (values) => {
                for (const [name, value] of Object.entries(values)) {
                    this.state[name] = value;
                    this.localIssues.delete(name);
                }
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
            return this.theme.fg(this.appearance.colors.focusedValue, rawValue);
        }
        return rawValue;
    }

    private renderMultiValue(field: FormField, selected: boolean, width: number): string {
        if (field.definition.type !== "multi-enum") {
            return paddedCell(formatValue(this.state[field.name]), width);
        }

        const currentValues = stringSelections(this.state[field.name]);
        const selectedValues = new Set(currentValues);
        const cursor = this.multiCursorByName.get(field.name) ?? 0;
        const parts = field.definition.values.map((value, index) => {
            let checkbox = this.symbols.unselectedCheckbox;
            if (selectedValues.has(value)) {
                checkbox = this.symbols.selectedCheckbox;
            }
            const text = `${checkbox} ${value}`;
            if (selected && index === cursor) {
                return this.theme.fg(this.appearance.colors.selectedOption, text);
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
        nameWidth: number,
        valueWidth: number,
    ): string[] {
        const parts = this.optionParts(field, selected);
        const optionGap = " ".repeat(Math.max(1, this.appearance.layout.fieldGap * 2));
        const optionsText = parts.join(optionGap);
        const fieldPrefix = prefix + name + " ".repeat(this.appearance.layout.fieldGap);
        if (visibleWidth(optionsText) <= valueWidth) {
            const base = fieldPrefix + paddedCell(optionsText, valueWidth);
            return [this.renderInlineFieldLine(base, field, selected, width)];
        }

        const base = fieldPrefix + paddedCell("", valueWidth);
        const lines = [this.renderInlineFieldLine(base, field, selected, width)];
        const optionPrefix = " ".repeat(
            this.appearance.layout.leftPadding + 2 + nameWidth + this.appearance.layout.fieldGap,
        );
        for (const part of parts) {
            lines.push(this.fitLine(optionPrefix + part, width));
        }
        return lines;
    }

    private optionParts(field: FormField, selected: boolean): string[] {
        switch (field.definition.type) {
            case "string":
            case "number":
            case "boolean":
                return [];
            case "enum":
                return this.enumOptionParts(field, selected);
            case "multi-enum":
                return this.multiOptionParts(field, selected);
            default:
                return casesHandled(field.definition);
        }
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
                text = this.theme.fg(this.appearance.colors.selectedOption, text);
            }
            return text;
        });
        return parts;
    }

    private multiOptionParts(field: FormField, selected: boolean): string[] {
        if (field.definition.type !== "multi-enum") {
            return [];
        }

        const currentValues = stringSelections(this.state[field.name]);
        const selectedValues = new Set(currentValues);
        const cursor = this.multiCursorByName.get(field.name) ?? 0;
        const parts = field.definition.values.map((value, index) => {
            let checkbox = this.symbols.unselectedCheckbox;
            if (selectedValues.has(value)) {
                checkbox = this.symbols.selectedCheckbox;
            }
            let text = `${checkbox} ${value}`;
            if (selected && index === cursor) {
                text = this.theme.fg(this.appearance.colors.selectedOption, text);
            }
            return text;
        });
        return parts;
    }

    private applyComputedValues(): void {
        for (const field of this.fields) {
            const compute = field.definition.ui?.compute;
            if (compute !== undefined) {
                this.state[field.name] = compute({ ...this.state });
                this.localIssues.delete(field.name);
            }
        }
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
        return this.theme.fg(this.appearance.colors.focusedValue, cell + " ".repeat(padding));
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
        const current = [...stringSelections(this.state[field.name])];
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
        this.applyComputedValues();
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
