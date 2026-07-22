import {
    CURSOR_MARKER,
    Editor,
    Input,
    matchesKey,
    truncateToWidth,
    visibleWidth,
    type Component,
    type Focusable,
    type AutocompleteProvider,
    type SelectListTheme,
    type TUI,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { getTypedFormValueCompletions, type CompletionCapabilities } from "../completions.js";
import { casesHandled } from "../exhaustive.js";
import { toKebabCase } from "../names.js";
import {
    coerceArgumentValue,
    normalizeTextArgumentInput,
    selectableArgumentValues,
    validateArgumentValue,
} from "../schema.js";
import type { FormField, FormState } from "../pi-tui/form-model.js";
import type {
    ArgumentDefinition,
    ArgumentFormKeybinding,
    ArgumentValue,
    ParseIssue,
    TypedCommandFormSymbols,
} from "../types.js";
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
    if (definition.type === "string") {
        if (definition.sensitive === true) {
            return "secret";
        }
        if (definition.format !== undefined) {
            return definition.format;
        }
    }
    if (definition.type === "number" && definition.step !== undefined) {
        return "stepper";
    }
    switch (definition.type) {
        case "string":
        case "number":
            return definition.type;
        case "string-list":
            return "list";
        case "key-value":
            return "key-value";
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
    return [
        "text",
        "textarea",
        "number",
        "path",
        "file",
        "directory",
        "command",
        "secret",
        "list",
        "key-value",
        "duration",
        "date",
        "time",
        "datetime",
        "url",
        "email",
        "json",
        "code",
        "stepper",
        "select",
    ].includes(widget);
}

function isTextareaWidget(definition: ArgumentDefinition): boolean {
    const widget = widgetFor(definition);
    return (
        widget === "textarea" ||
        widget === "command" ||
        widget === "code" ||
        widget === "path" ||
        widget === "file" ||
        widget === "directory" ||
        definition.complete !== undefined ||
        definition.completeAsync !== undefined ||
        widget === "select"
    );
}

function isMultilineWidget(definition: ArgumentDefinition): boolean {
    const widget = widgetFor(definition);
    return widget === "textarea" || widget === "command" || widget === "code";
}

function editorRows(definition: ArgumentDefinition): number {
    const widget = widgetFor(definition);
    if (widget === "textarea" || widget === "command" || widget === "code") {
        return definition.ui?.rows ?? 4;
    }
    return 1;
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
    if (evaluateFormBoolean(definition.ui?.hidden, state)) {
        return true;
    }
    const visibleWhen = definition.ui?.visibleWhen;
    return visibleWhen !== undefined && !evaluateFormBoolean(visibleWhen, state);
}

function isReadOnlyWidget(definition: ArgumentDefinition, state: FormState): boolean {
    const widget = widgetFor(definition);
    return (
        widget === "readonly" ||
        widget === "computed" ||
        definition.ui?.compute !== undefined ||
        evaluateFormBoolean(definition.ui?.readOnly, state) ||
        evaluateFormBoolean(definition.ui?.disabled, state) ||
        (definition.ui?.enabledWhen !== undefined &&
            !evaluateFormBoolean(definition.ui.enabledWhen, state))
    );
}

function fieldTitle(field: FormField): string {
    return field.definition.title ?? field.definition.ui?.title ?? toKebabCase(field.name);
}

function validateFormFieldValue(field: FormField, state: FormState): string | undefined {
    if (
        evaluateFormBoolean(field.definition.ui?.requiredWhen, state) &&
        state[field.name] === undefined
    ) {
        return `${fieldTitle(field)} is required`;
    }
    const validation = validateArgumentValue(
        field.name,
        field.definition,
        state[field.name],
        FORM_MESSAGE_OPTIONS,
    );
    if (!validation.ok) {
        return validation.message;
    }
    return undefined;
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
    if (typeof value === "object") {
        return Object.entries(value)
            .map(([key, entryValue]) => `${key}=${entryValue}`)
            .join(", ");
    }
    return String(value);
}

function formatFieldValue(definition: ArgumentDefinition, value: ArgumentValue): string {
    if (definition.type === "string" && definition.sensitive === true && value !== undefined) {
        return "••••••••";
    }
    if (definition.type === "number" && value !== undefined && definition.unit !== undefined) {
        return `${formatValue(value)} ${definition.unit}`;
    }
    return formatValue(value);
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
    private touchedFields = new Set<string>();
    private readonly fields: FormField[];
    private readonly state: FormState;
    private readonly initialState: Readonly<FormState>;
    private readonly title: string;
    private readonly theme: FormTheme;
    private readonly symbols: ResolvedFormSymbols;
    private readonly appearance: ResolvedFormAppearance;
    private readonly completionCapabilities: CompletionCapabilities | undefined;
    private readonly keybindings: KeybindingsManager;
    private readonly validateState: (state: FormState) => readonly ParseIssue[];
    private readonly maxRows: number;
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
        completionCapabilities: CompletionCapabilities | undefined,
        keybindings: KeybindingsManager,
        validateState: (state: FormState) => readonly ParseIssue[],
        done: (result: FormResult | undefined) => void,
        selectedIndex = 0,
    ) {
        this.title = title;
        this.fields = fields;
        this.state = state;
        this.initialState = { ...state };
        this.theme = theme;
        this.appearance = appearance;
        this.completionCapabilities = completionCapabilities;
        this.keybindings = keybindings;
        this.validateState = validateState;
        this.maxRows = Math.max(8, tui.terminal.rows - 3);
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
        this.configureEditorAutocomplete();
        this.syncInputFromState();
    }

    invalidate(): void {
        this.input.invalidate();
        this.editor.invalidate();
    }

    handleInput(data: string): void {
        if (this.matches(data, "tui.select.cancel")) {
            this.done(undefined);
            return;
        }
        const field = this.selectedField();
        if (this.matches(data, "tui.input.tab")) {
            if (isTextareaWidget(field.definition) && !isMultilineWidget(field.definition)) {
                this.editor.handleInput(data);
                this.commitInput(false);
                return;
            }
            this.moveSelection(1);
            return;
        }
        this.applyComputedValues();
        if (this.handleCustomInput(field, data)) {
            return;
        }
        if (isReadOnlyWidget(field.definition, this.state)) {
            if (this.matches(data, "tui.select.up")) {
                this.moveSelection(-1);
            } else if (this.matches(data, "tui.select.down")) {
                this.moveSelection(1);
            } else if (this.matches(data, "tui.input.submit")) {
                this.submit();
            }
            return;
        }

        if (!isTextWidget(field.definition) && this.matches(data, "tui.editor.undo")) {
            this.state[field.name] = this.initialState[field.name];
            this.touchedFields.add(field.name);
            this.localIssues.clear();
            return;
        }

        if (isTextareaWidget(field.definition)) {
            if (this.matches(data, "tui.input.submit")) {
                this.submit();
                return;
            }
            if (!isMultilineWidget(field.definition) && this.matches(data, "tui.select.up")) {
                this.moveSelection(-1);
                return;
            }
            if (!isMultilineWidget(field.definition) && this.matches(data, "tui.select.down")) {
                this.moveSelection(1);
                return;
            }
            this.editor.handleInput(data);
            this.commitInput(false);
            return;
        }

        if (this.matches(data, "tui.select.up")) {
            this.moveSelection(-1);
            return;
        }
        if (this.matches(data, "tui.select.down")) {
            this.moveSelection(1);
            return;
        }
        if (this.matches(data, "tui.input.submit")) {
            this.submit();
            return;
        }

        if (this.handleDiscreteInput(field, data)) {
            return;
        }

        if (isTextWidget(field.definition)) {
            this.handleTextInput(field, data);
        }
    }

    private handleDiscreteInput(field: FormField, data: string): boolean {
        switch (field.definition.type) {
            case "string":
            case "string-list":
            case "key-value":
                return false;
            case "number": {
                if (widgetFor(field.definition) !== "stepper") {
                    return false;
                }
                let direction = 0;
                if (this.matches(data, "tui.editor.cursorLeft")) {
                    direction = -1;
                } else if (this.matches(data, "tui.editor.cursorRight")) {
                    direction = 1;
                }
                if (direction === 0) {
                    return false;
                }
                const existing = this.state[field.name];
                let current = field.definition.default ?? field.definition.min ?? 0;
                if (typeof existing === "number") {
                    current = existing;
                }
                const step = field.definition.step ?? 1;
                let next = current + direction * step;
                if (field.definition.min !== undefined) {
                    next = Math.max(field.definition.min, next);
                }
                if (field.definition.max !== undefined) {
                    next = Math.min(field.definition.max, next);
                }
                this.setCurrentValue(next);
                return true;
            }
            case "boolean":
            case "enum":
                if (this.matches(data, "tui.editor.cursorLeft")) {
                    this.setCurrentValue(stepValue(field.definition, this.state[field.name], -1));
                    return true;
                }
                if (this.matches(data, "tui.editor.cursorRight") || matchesKey(data, "space")) {
                    this.setCurrentValue(stepValue(field.definition, this.state[field.name], 1));
                    return true;
                }
                return false;
            case "multi-enum":
                if (this.matches(data, "tui.editor.cursorLeft")) {
                    this.moveMultiCursor(field, -1);
                    return true;
                }
                if (this.matches(data, "tui.editor.cursorRight")) {
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

        let previousSection: string | undefined;
        for (let index = 0; index < this.fields.length; index += 1) {
            const field = this.fields[index];
            if (
                field !== undefined &&
                !isHiddenField(field.definition, this.state) &&
                field.section !== undefined &&
                field.section !== previousSection
            ) {
                lines.push(
                    this.fitLine(
                        this.theme.fg(this.appearance.colors.description, `  ${field.section}`),
                        width,
                    ),
                );
                previousSection = field.section;
            }
            lines.push(...this.renderField(index, width, nameWidth, valueWidth));
        }

        const selectedIssue = this.currentIssue();
        if (selectedIssue !== undefined) {
            lines.push(
                this.fitLine(
                    this.theme.fg(this.appearance.colors.issue, `  ! ${selectedIssue}`),
                    width,
                ),
            );
        }

        lines.push(this.renderSeparator(width));
        const instructions = this.instructionsText();
        if (instructions !== undefined) {
            lines.push(
                this.fitLine(
                    this.theme.fg(this.appearance.colors.instructions, `  ${instructions}`),
                    width,
                ),
            );
        }
        const viewport = this.applyViewport(lines, Math.max(1, this.maxRows - 2));
        const border = this.renderSeparator(width);
        return [border, ...viewport, border];
    }

    private applyViewport(lines: string[], maxRows: number): string[] {
        if (lines.length <= maxRows) {
            return lines;
        }
        const selectedLine = Math.max(
            2,
            lines.findIndex((line) => line.includes(this.symbols.focusedField)),
        );
        const bodyRows = Math.max(3, maxRows - 4);
        const maxStart = Math.max(2, lines.length - bodyRows - 1);
        const start = Math.min(maxStart, Math.max(2, selectedLine - Math.floor(bodyRows / 2)));
        const end = Math.min(lines.length - 1, start + bodyRows);
        const viewport = [lines[0] ?? "", ""];
        if (start > 2) {
            viewport.push(this.theme.fg(this.appearance.colors.instructions, "  ↑ more"));
        }
        viewport.push(...lines.slice(start, end));
        if (end < lines.length - 1) {
            viewport.push(this.theme.fg(this.appearance.colors.instructions, "  ↓ more"));
        }
        viewport.push(lines[lines.length - 1] ?? "");
        return viewport.slice(0, maxRows);
    }

    private renderHeader(width: number): string {
        return this.fitLine(
            this.theme.fg(this.appearance.colors.title, this.theme.bold(this.title)),
            width,
        );
    }

    private renderSeparator(width: number): string {
        return this.theme.fg(this.appearance.colors.editorBorder, "─".repeat(Math.max(0, width)));
    }

    private instructionsText(): string | undefined {
        const submit = this.keybindingText("tui.input.submit");
        const tab = this.keybindingText("tui.input.tab");
        const cancel = this.keybindingText("tui.select.cancel");
        switch (this.appearance.layout.instructions) {
            case "full":
                return `${submit} submit · ${tab} next field · ${cancel} cancel`;
            case "short":
                return `${submit} submit · ${cancel} cancel`;
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
        } else if (this.fieldHasRefinementIssue(field.name)) {
            name = this.theme.fg(this.appearance.colors.issue, rawName);
        }
        const prefix = " ".repeat(this.appearance.layout.leftPadding) + marker + " ";
        if (selected && isMultilineWidget(field.definition)) {
            let heading =
                prefix + this.theme.fg(this.appearance.colors.focusedLabel, fieldTitle(field));
            if (
                field.definition.description !== undefined &&
                this.shouldRenderDescription(selected)
            ) {
                heading +=
                    "  " +
                    this.theme.fg(this.appearance.colors.description, field.definition.description);
            }
            const lines = [this.fitLine(heading, width)];
            const editorWidth = Math.max(20, width - this.appearance.layout.leftPadding - 2);
            for (const line of this.renderMultilineEditor(
                editorWidth,
                editorRows(field.definition),
            )) {
                lines.push(
                    this.fitLine(" ".repeat(this.appearance.layout.leftPadding + 2) + line, width),
                );
            }
            return lines;
        }

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
            const rows = editorRows(field.definition);
            for (const line of this.editor.render(editorWidth).slice(0, rows)) {
                lines.push(
                    this.fitLine(" ".repeat(this.appearance.layout.leftPadding + 2) + line, width),
                );
            }
        }

        return lines;
    }

    private renderMultilineEditor(width: number, preferredRows: number): string[] {
        const rendered = [...this.editor.render(width)];
        const topBorder = rendered[0];
        const bottomBorderIndex = rendered.findIndex(
            (line, index) => index > 0 && line === topBorder,
        );
        if (bottomBorderIndex < 0) {
            return rendered;
        }

        const missingRows = Math.max(0, preferredRows - (bottomBorderIndex - 1));
        if (missingRows > 0) {
            rendered.splice(
                bottomBorderIndex,
                0,
                ...Array.from({ length: missingRows }, () => " ".repeat(width)),
            );
        }
        return rendered;
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
            if (widgetFor(field.definition) === "secret") {
                return this.renderSelectedSecretInput(width);
            }
            return this.renderSelectedInput(width);
        }

        switch (field.definition.type) {
            case "boolean":
                return this.renderBooleanValue(field, selected, width);
            case "multi-enum":
                return this.renderMultiValue(field, selected, width);
            case "string":
            case "number":
            case "string-list":
            case "key-value":
            case "enum": {
                const rawValue = paddedCell(
                    formatFieldValue(field.definition, this.state[field.name]).replace(
                        /\r\n|\r|\n/g,
                        " ↵ ",
                    ),
                    width,
                );
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
            matchesKeybinding: (action) => this.matchesFormAction(data, action),
            setValue: (value) => {
                this.state[field.name] = value;
                this.touchedFields.add(field.name);
                this.localIssues.clear();
            },
            setValues: (values) => {
                for (const [name, value] of Object.entries(values)) {
                    this.state[name] = value;
                    this.touchedFields.add(name);
                }
                this.localIssues.clear();
            },
        });
        return result === true;
    }

    private renderBooleanValue(field: FormField, selected: boolean, width: number): string {
        const value = this.state[field.name];
        const confirm = widgetFor(field.definition) === "confirm";
        let rendered = this.symbols.unselectedCheckbox;
        if (value === true) {
            rendered = this.symbols.selectedCheckbox;
        }
        if (confirm) {
            if (value === true) {
                rendered += " confirmed";
            } else {
                rendered += " not confirmed";
            }
        }
        const rawValue = paddedCell(rendered, width);
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
            case "string-list":
            case "key-value":
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
        const definition = field.definition;
        if (definition.type !== "enum") {
            return [];
        }

        const optionLabelWidth = Math.max(...definition.values.map((value) => visibleWidth(value)));
        const parts = definition.values.map((value) => {
            let radio = this.symbols.unselectedRadio;
            if (this.state[field.name] === value) {
                radio = this.symbols.selectedRadio;
            }
            let text = `${radio} ${value}`;
            if (selected && this.state[field.name] === value) {
                text = this.theme.fg(this.appearance.colors.selectedOption, text);
            }
            const description = definition.optionDescriptions?.[value];
            if (description !== undefined) {
                const labelPadding = " ".repeat(optionLabelWidth - visibleWidth(value));
                text += `${labelPadding}  ${this.theme.fg(this.appearance.colors.description, description)}`;
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
            const copyFrom = field.definition.ui?.copyFrom;
            if (
                copyFrom !== undefined &&
                this.state[field.name] === undefined &&
                this.state[copyFrom] !== undefined
            ) {
                this.state[field.name] = this.state[copyFrom];
            }
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
        cell = truncateToWidth(cell, width, "");
        if (!cell.includes(CURSOR_MARKER)) {
            cell += CURSOR_MARKER;
        }
        cell = truncateToWidth(cell, width, "");
        const padding = Math.max(0, width - visibleWidth(cell));
        return this.theme.fg(this.appearance.colors.focusedValue, cell + " ".repeat(padding));
    }

    private renderSelectedSecretInput(width: number): string {
        const bullets = "•".repeat(this.input.getValue().length);
        const cell = `${bullets}${CURSOR_MARKER}`;
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
        if (widgetFor(field.definition) === "confirm" && this.state[field.name] !== true) {
            return `${fieldTitle(field)} must be confirmed`;
        }
        const validationMessage = validateFormFieldValue(field, this.state);
        if (validationMessage !== undefined) {
            return validationMessage;
        }
        const refinement = this.validateState({ ...this.state }).find(
            (issue) =>
                issue.name === field.name || issue.relatedNames?.includes(field.name) === true,
        );
        if (refinement !== undefined) {
            return refinement.message;
        }
        if (this.touchedFields.has(field.name)) {
            return undefined;
        }
        return field.issueMessages[0];
    }

    private fieldHasRefinementIssue(name: string): boolean {
        return this.validateState({ ...this.state }).some(
            (issue) => issue.name === name || issue.relatedNames?.includes(name) === true,
        );
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
        let nextIndex = this.selectedIndex;
        for (let visited = 0; visited < this.fields.length; visited += 1) {
            nextIndex = (nextIndex + delta + this.fields.length) % this.fields.length;
            const next = this.fields[nextIndex];
            if (next !== undefined && !isHiddenField(next.definition, this.state)) {
                this.selectedIndex = nextIndex;
                break;
            }
        }
        this.syncInputFromState();
    }

    private matches(data: string, action: Parameters<KeybindingsManager["matches"]>[1]): boolean {
        return this.keybindings.matches(data, action);
    }

    private keybindingText(action: Parameters<KeybindingsManager["getKeys"]>[0]): string {
        const keys = this.keybindings.getKeys(action);
        if (keys.length === 0) {
            return action;
        }
        return keys.join("/");
    }

    private matchesFormAction(data: string, action: ArgumentFormKeybinding): boolean {
        switch (action) {
            case "cursor-up":
                return this.matches(data, "tui.editor.cursorUp");
            case "cursor-down":
                return this.matches(data, "tui.editor.cursorDown");
            case "cursor-left":
                return this.matches(data, "tui.editor.cursorLeft");
            case "cursor-right":
                return this.matches(data, "tui.editor.cursorRight");
            case "new-line":
                return this.matches(data, "tui.input.newLine");
            case "submit":
                return this.matches(data, "tui.input.submit");
            case "tab":
                return this.matches(data, "tui.input.tab");
            case "confirm":
                return this.matches(data, "tui.select.confirm");
            case "cancel":
                return this.matches(data, "tui.select.cancel");
            default:
                return casesHandled(action);
        }
    }

    private setCurrentValue(value: ArgumentValue): void {
        const field = this.selectedField();
        this.state[field.name] = value;
        this.touchedFields.add(field.name);
        this.localIssues.clear();
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
        let value = normalizeTextArgumentInput(field.definition, rawValue);
        if (field.definition.type === "enum" && rawValue.trim().length > 0) {
            const coerced = coerceArgumentValue(
                field.definition,
                rawValue,
                field.name,
                FORM_MESSAGE_OPTIONS,
            );
            if (!coerced.ok) {
                this.localIssues.set(field.name, coerced.issue.message);
                return !strict;
            }
            value = coerced.value;
        }
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
        this.touchedFields.add(field.name);
        this.localIssues.clear();
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
        this.touchedFields.add(field.name);
        this.localIssues.delete(field.name);
    }

    private syncInputFromState(): void {
        const field = this.selectedField();
        this.configureEditorAutocomplete();
        if (!isTextWidget(field.definition)) {
            setInputValueAtEnd(this.input, "");
            this.editor.setText("");
            return;
        }

        const value = this.state[field.name];
        let text = "";
        if (value !== undefined) {
            text = formatValue(value);
        }
        if (isTextareaWidget(field.definition)) {
            this.editor.setText(text);
            setInputValueAtEnd(this.input, "");
            return;
        }
        setInputValueAtEnd(this.input, text);
        this.editor.setText("");
    }

    private configureEditorAutocomplete(): void {
        const capabilities = this.completionCapabilities;
        if (capabilities === undefined || this.fields.length === 0) {
            return;
        }
        const provider: AutocompleteProvider = {
            getSuggestions: async (lines, cursorLine, cursorCol) => {
                const field = this.selectedField();
                const line = lines[cursorLine] ?? "";
                let query = line.slice(0, cursorCol);
                if (field.definition.type === "string-list") {
                    const commaIndex = query.lastIndexOf(",");
                    if (commaIndex >= 0) {
                        query = query.slice(commaIndex + 1).trimStart();
                    }
                }
                const provided = new Set(
                    Object.entries(this.state)
                        .filter(([, value]) => value !== undefined)
                        .map(([name]) => name),
                );
                const items = await getTypedFormValueCompletions(
                    field.definition,
                    query,
                    { values: { ...this.state }, provided },
                    capabilities,
                );
                if (items.length === 0) {
                    return null;
                }
                return {
                    prefix: query,
                    items: items.map((item) => {
                        const mapped: {
                            value: string;
                            label: string;
                            description?: string;
                        } = {
                            value: item.replacement ?? item.value,
                            label: item.label ?? item.value,
                        };
                        if (item.description !== undefined) {
                            mapped.description = item.description;
                        }
                        return mapped;
                    }),
                };
            },
            applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
                const next = [...lines];
                const line = next[cursorLine] ?? "";
                next[cursorLine] =
                    `${line.slice(0, cursorCol - prefix.length)}${item.value}${line.slice(cursorCol)}`;
                return {
                    lines: next,
                    cursorLine,
                    cursorCol: cursorCol - prefix.length + item.value.length,
                };
            },
        };
        this.editor.setAutocompleteProvider(provider);
    }

    private submit(): void {
        this.applyComputedValues();
        if (!this.commitInput(true)) {
            return;
        }

        const messages: string[] = [];
        for (const field of this.fields) {
            if (widgetFor(field.definition) === "confirm" && this.state[field.name] !== true) {
                const message = `${fieldTitle(field)} must be confirmed`;
                messages.push(message);
                this.localIssues.set(field.name, message);
                continue;
            }
            const validationMessage = validateFormFieldValue(field, this.state);
            if (validationMessage === undefined) {
                continue;
            }
            messages.push(validationMessage);
            this.localIssues.set(field.name, validationMessage);
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

        const refinementIssues = this.validateState({ ...this.state });
        if (refinementIssues.length > 0) {
            for (const issue of refinementIssues) {
                if (issue.name !== undefined) {
                    this.localIssues.set(issue.name, issue.message);
                }
            }
            const firstIssue = refinementIssues[0];
            const firstInvalidIndex = this.fields.findIndex(
                (field) =>
                    field.name === firstIssue?.name ||
                    firstIssue?.relatedNames?.includes(field.name) === true,
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
