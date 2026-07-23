import {
    getSelectListTheme,
    type KeybindingsManager,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import {
    Editor,
    Input,
    Key,
    matchesKey,
    truncateToWidth,
    type Component,
    type Focusable,
    type TUI,
    visibleWidth,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import {
    colorSwatch,
    completeSettingsPath,
    formatSliderValue,
    stepSettingsNumber,
} from "./settings-controls.ts";
import {
    formatSettingLabel,
    type JsonPrimitive,
    type JsonValue,
    type SettingsControl,
    type SettingsValueNode,
} from "./settings-schema.ts";
import { type EditorFieldView, SettingsEditorModel } from "./settings-editor.ts";
import type { PiSettingsPane } from "./pi-settings-tab.ts";
import { type SaveSettingsLayerOutcome, type SaveSettingsLayerRequest } from "./settings-store.ts";
import {
    addStructuredEntry,
    buildStructuredRows,
    cycleStructuredVariant,
    initialStructuredInput,
    parseStructuredInput,
    removeStructuredEntry,
    renameStructuredMapEntry,
    setStructuredValueAtPath,
    structuredRowLabel,
    structuredRowValue,
    type StructuredEditorRow,
    type StructuredValuePath,
    type StructuredValueOutcome,
} from "./structured-settings-editor.ts";

export type SettingsUiTheme = Pick<Theme, "bg" | "bold" | "fg">;

export type SettingsEditorComponentOptions = {
    readonly cwd: string;
    readonly model: SettingsEditorModel;
    readonly piSettings: PiSettingsPane;
    readonly tui: TUI;
    readonly theme: SettingsUiTheme;
    readonly keybindings: Pick<KeybindingsManager, "matches">;
    readonly save: (
        requests: readonly SaveSettingsLayerRequest[],
    ) => Promise<readonly SaveSettingsLayerOutcome[]>;
    readonly close: () => void;
};

type EditingField = {
    readonly fieldIndex: number;
    readonly editor: Editor;
    error: string | undefined;
};

type InlineEditingField = {
    readonly fieldIndex: number;
    readonly input: Input;
    error: string | undefined;
};

type StructuredTextEditing =
    | {
          readonly _tag: "StructuredFullTextEditing";
          readonly mode: "rename" | "value";
          readonly rowIndex: number;
          readonly editor: Editor;
          error: string | undefined;
      }
    | {
          readonly _tag: "StructuredInlineTextEditing";
          readonly mode: "rename" | "value";
          readonly rowIndex: number;
          readonly input: Input;
          error: string | undefined;
      };

type StructuredEditing = {
    readonly fieldIndex: number;
    selectedRow: number;
    scrollOffset: number;
    textEditing: StructuredTextEditing | undefined;
};

type TabPicker = {
    query: string;
    selectedIndex: number;
    scrollOffset: number;
};

type TabChoice = {
    readonly tabIndex: number;
    readonly title: string;
    readonly dirty: boolean;
    readonly blocked: boolean;
};

type ValuePickerOption = {
    readonly label: string;
    readonly value: JsonPrimitive;
};

type ValuePickerTarget =
    | { readonly _tag: "MainFieldTarget"; readonly fieldIndex: number }
    | {
          readonly _tag: "StructuredValueTarget";
          readonly fieldIndex: number;
          readonly node: SettingsValueNode;
          readonly path: StructuredValuePath;
      };

type ValuePicker = {
    readonly allowCustom: boolean;
    readonly initialValue: JsonValue | undefined;
    readonly options: readonly ValuePickerOption[];
    readonly target: ValuePickerTarget;
    readonly title: string;
    query: string;
    selectedIndex: number;
    scrollOffset: number;
    error: string | undefined;
};

type FilteredValuePickerOption = ValuePickerOption & {
    readonly _tag: "CustomValue" | "SchemaValue";
};

function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
    return Array.isArray(value);
}

function isJsonObject(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
    return value !== null && typeof value === "object" && !isJsonArray(value);
}

function countLabel(key: string, count: number): string {
    const label = formatSettingLabel(key).toLocaleLowerCase();
    if (count === 1) {
        if (label.endsWith("ies")) return `${label.slice(0, -3)}y`;
        return label.endsWith("s") ? label.slice(0, -1) : label;
    }
    return label.endsWith("s") ? label : `${label}s`;
}

function displayValue(field: EditorFieldView): string {
    const { value } = field;
    if (value === undefined) return "<unset>";
    if (value === null) return "<none>";
    if (typeof value === "string") {
        if (value === "") return '""';
        if (
            field.control._tag === "ChoiceControl" ||
            (field.control._tag === "ReadOnlyControl" && field.control.fixedValue !== undefined)
        ) {
            return formatSettingLabel(value);
        }
        const text = value.replaceAll(/\s*\n\s*/g, " ");
        if (field.control._tag !== "TextControl" || field.control.presentation !== "color") {
            return text;
        }
        const swatch = colorSwatch(value);
        return swatch === undefined ? text : `${text} ${swatch}`;
    }
    if (isJsonArray(value)) {
        if (field.control._tag === "ListControl") {
            const presentation = field.control.presentation;
            if (presentation._tag === "StringListPresentation") {
                return `${value.length} ${value.length === 1 ? "entry" : "entries"}`;
            }
            if (presentation._tag === "GroupedStringListPresentation") {
                let valueCount = 0;
                for (const item of value) {
                    if (!isJsonObject(item)) continue;
                    const entries = item[presentation.valuesKey];
                    if (isJsonArray(entries)) valueCount += entries.length;
                }
                return `${value.length} ${countLabel(presentation.groupKey, value.length)} · ${valueCount} ${countLabel(presentation.valuesKey, valueCount)}`;
            }
        }
        return `${value.length} ${value.length === 1 ? "entry" : "entries"}`;
    }
    if (typeof value === "object") {
        const count = Object.keys(value).length;
        return `${count} ${count === 1 ? "entry" : "entries"}`;
    }
    if (
        field.control._tag === "NumberControl" &&
        field.control.presentation === "slider" &&
        typeof value === "number"
    ) {
        return formatSliderValue(field.control, value);
    }
    return String(value);
}

type PreviewRow = {
    readonly depth: number;
    readonly text: string;
    readonly group: boolean;
    readonly aligned?: true;
};

function singleLineValue(value: string): string {
    if (value === "") return "<empty>";
    return value.replaceAll(/\s*\n\s*/g, " ");
}

function primitivePreview(value: JsonValue): string | undefined {
    if (value === null) return "<none>";
    if (typeof value === "string") return singleLineValue(value);
    if (typeof value === "boolean" || typeof value === "number") return String(value);
    return undefined;
}

function collectionCount(
    value: readonly JsonValue[] | Readonly<Record<string, JsonValue>>,
): string {
    const count = isJsonArray(value) ? value.length : Object.keys(value).length;
    return `${count} ${count === 1 ? "entry" : "entries"}`;
}

function appendNamedPreview(
    rows: PreviewRow[],
    label: string,
    value: JsonValue,
    depth: number,
): void {
    const primitive = primitivePreview(value);
    if (primitive !== undefined) {
        rows.push({ depth, text: `${label}  ${primitive}`, group: false, aligned: true });
        return;
    }
    if (isJsonArray(value)) {
        rows.push({
            depth,
            text: `${label}  ${collectionCount(value)}`,
            group: false,
            aligned: true,
        });
        return;
    }
    if (!isJsonObject(value)) return;
    if (depth >= 4) {
        rows.push({
            depth,
            text: `${label}  ${collectionCount(value)}`,
            group: false,
            aligned: true,
        });
        return;
    }
    rows.push({ depth, text: label, group: true });
    for (const [key, child] of Object.entries(value)) {
        appendNamedPreview(rows, formatSettingLabel(key), child, depth + 1);
    }
}

function recordHeading(value: Readonly<Record<string, JsonValue>>):
    | {
          readonly keys: readonly string[];
          readonly text: string;
      }
    | undefined {
    const id = value.id;
    const idPreview = id === undefined ? undefined : primitivePreview(id);
    if (idPreview !== undefined) return { keys: ["id"], text: idPreview };

    const provider = value.provider;
    const model = value.model ?? value.modelId;
    const providerPreview = provider === undefined ? undefined : primitivePreview(provider);
    const modelPreview = model === undefined ? undefined : primitivePreview(model);
    if (providerPreview !== undefined && modelPreview !== undefined) {
        return {
            keys: ["provider", value.model === undefined ? "modelId" : "model"],
            text: `${providerPreview}/${modelPreview}`,
        };
    }

    for (const key of ["key", "provider", "name", "label", "title", "alias"]) {
        const candidate = value[key];
        const preview = candidate === undefined ? undefined : primitivePreview(candidate);
        if (preview !== undefined) return { keys: [key], text: preview };
    }
    return undefined;
}

function genericListPreviewRows(values: readonly JsonValue[]): readonly PreviewRow[] {
    if (values.length === 0) return [{ depth: 2, text: "No entries", group: false }];
    const rows: PreviewRow[] = [];
    for (const [index, value] of values.entries()) {
        const primitive = primitivePreview(value);
        if (primitive !== undefined) {
            rows.push({ depth: 2, text: primitive, group: false });
            continue;
        }
        if (isJsonArray(value)) {
            rows.push({ depth: 2, text: collectionCount(value), group: false });
            continue;
        }
        if (!isJsonObject(value)) continue;
        const heading = recordHeading(value);
        rows.push({
            depth: 2,
            text: heading?.text ?? `Entry ${index + 1}`,
            group: true,
        });
        for (const [key, child] of Object.entries(value)) {
            if (heading?.keys.includes(key) === true) continue;
            appendNamedPreview(rows, formatSettingLabel(key), child, 3);
        }
    }
    return rows;
}

function objectPreviewRows(value: Readonly<Record<string, JsonValue>>): readonly PreviewRow[] {
    const entries = Object.entries(value);
    if (entries.length === 0) return [{ depth: 2, text: "No entries", group: false }];
    const rows: PreviewRow[] = [];
    for (const [key, child] of entries) {
        const primitive = primitivePreview(child);
        if (primitive !== undefined) {
            rows.push({
                depth: 2,
                text: `${singleLineValue(key)}  ${primitive}`,
                group: false,
                aligned: true,
            });
            continue;
        }
        if (isJsonArray(child)) {
            rows.push({
                depth: 2,
                text: `${singleLineValue(key)}  ${collectionCount(child)}`,
                group: false,
                aligned: true,
            });
            continue;
        }
        if (!isJsonObject(child)) continue;
        rows.push({ depth: 2, text: singleLineValue(key), group: true });
        for (const [nestedKey, nestedValue] of Object.entries(child)) {
            appendNamedPreview(rows, formatSettingLabel(nestedKey), nestedValue, 3);
        }
    }
    return rows;
}

function collectionPreviewRows(field: EditorFieldView): readonly PreviewRow[] {
    if (isJsonObject(field.value)) return objectPreviewRows(field.value);
    if (!isJsonArray(field.value)) return [];
    if (field.control._tag !== "ListControl") return genericListPreviewRows(field.value);
    const presentation = field.control.presentation;
    if (presentation._tag === "GenericListPresentation") {
        return genericListPreviewRows(field.value);
    }

    const rows: PreviewRow[] = [];
    if (presentation._tag === "StringListPresentation") {
        for (const value of field.value) {
            if (typeof value === "string") {
                rows.push({ depth: 2, text: singleLineValue(value), group: false });
            }
        }
    } else {
        for (const group of field.value) {
            if (!isJsonObject(group)) continue;
            const label = group[presentation.groupKey];
            const values = group[presentation.valuesKey];
            if (typeof label !== "string" || !isJsonArray(values)) continue;
            rows.push({ depth: 2, text: singleLineValue(label), group: true });
            for (const value of values) {
                if (typeof value === "string") {
                    rows.push({ depth: 3, text: singleLineValue(value), group: false });
                }
            }
        }
    }
    return rows.length === 0 ? [{ depth: 2, text: "No entries", group: false }] : rows;
}

function renderCollectionPreview(
    field: EditorFieldView,
    width: number,
    budget: number,
    theme: SettingsUiTheme,
): string[] {
    const rows = collectionPreviewRows(field);
    if (rows.length === 0 || budget <= 0) return [];
    const visible = rows.slice(0, budget);
    if (rows.length > budget) {
        visible[Math.max(0, budget - 1)] = {
            depth: 2,
            text: `… ${rows.length - budget + 1} more`,
            group: false,
        };
    }
    const labelWidths = new Map<number, number>();
    for (const row of visible) {
        if (row.aligned !== true) continue;
        const separator = row.text.indexOf("  ");
        if (separator === -1) continue;
        const labelWidth = visibleWidth(row.text.slice(0, separator));
        labelWidths.set(row.depth, Math.max(labelWidths.get(row.depth) ?? 0, labelWidth));
    }
    return visible.map((row) => {
        let text = row.text;
        if (row.aligned === true) {
            const separator = text.indexOf("  ");
            const labelWidth = labelWidths.get(row.depth);
            if (separator !== -1 && labelWidth !== undefined) {
                const label = text.slice(0, separator);
                const value = text.slice(separator + 2);
                text = `${label}${" ".repeat(Math.max(0, labelWidth - visibleWidth(label)))}  ${value}`;
            }
        }
        return truncateToWidth(
            `${"  ".repeat(row.depth)}${theme.fg(row.group ? "text" : "muted", text)}`,
            width,
            "",
        );
    });
}

function compactExtensionTitle(title: string): string {
    return title.replace(/^pi[\s_-]+/i, "").trim() || title;
}

function isPrintableText(data: string): boolean {
    if (data === "") return false;
    for (const character of data) {
        const codePoint = character.codePointAt(0);
        if (codePoint === undefined || codePoint < 32 || codePoint === 127) return false;
    }
    return true;
}

function primitiveChoiceLabel(value: JsonPrimitive): string {
    if (value === null) return "None";
    if (typeof value === "string") return value === "" ? "Disabled" : formatSettingLabel(value);
    return String(value);
}

function fieldGroup(field: EditorFieldView, extensionTitle: string): string {
    const path = field.path.slice(0, -1).map(formatSettingLabel);
    const extensionName = compactExtensionTitle(extensionTitle).toLocaleLowerCase();
    if (path[0]?.toLocaleLowerCase() === extensionName) path.shift();
    return path.join(" › ");
}

function structuredNodeForField(field: EditorFieldView): SettingsValueNode {
    return {
        label: field.label,
        description: field.description,
        constraints: field.constraints,
        required: field.required,
        defaultValue: field.value,
        control: field.control,
    };
}

function structuredDisplayValue(row: StructuredEditorRow): string {
    if (row._tag !== "ValueRow") return structuredRowValue(row);
    if (
        row.node.control._tag === "NumberControl" &&
        row.node.control.presentation === "slider" &&
        typeof row.value === "number"
    ) {
        return formatSliderValue(row.node.control, row.value);
    }
    if (
        row.node.control._tag === "TextControl" &&
        row.node.control.presentation === "color" &&
        typeof row.value === "string"
    ) {
        const swatch = colorSwatch(row.value);
        if (swatch !== undefined) return `${structuredRowValue(row)} ${swatch}`;
    }
    return structuredRowValue(row);
}

function controlGuidance(control: SettingsControl): string {
    switch (control._tag) {
        case "ChoiceControl":
            return control.presentation === "segmented"
                ? "Left and Right change the value."
                : "Enter opens searchable choices.";
        case "NumberControl":
            return control.presentation === "slider"
                ? "Left and Right adjust the value; Enter types an exact value."
                : "Enter edits the number inline.";
        case "TextControl":
            switch (control.presentation) {
                case "color":
                    return "Enter edits the color inline; valid hexadecimal colors show a swatch.";
                case "combobox":
                    return "Enter searches suggestions or accepts a custom value.";
                case "path":
                    return "Enter edits the path inline; Tab completes filesystem paths.";
                case "text":
                    return "Enter edits the value inline.";
                case "textarea":
                    return "Enter opens the multiline editor.";
            }
        case "JsonControl":
            return "Enter opens the validated JSON editor.";
        case "BooleanControl":
        case "ListControl":
        case "MapControl":
        case "NullControl":
        case "ObjectControl":
        case "ReadOnlyControl":
        case "UnionControl":
            return "";
    }
}

function renderInlineControl(input: Input, control: SettingsControl, width: number): string {
    if (control._tag !== "TextControl" || control.presentation !== "color") {
        return input.render(width)[0] ?? "";
    }
    const swatch = colorSwatch(input.getValue());
    if (swatch === undefined || width < 4) return input.render(width)[0] ?? "";
    const swatchWidth = visibleWidth(swatch);
    const inputWidth = Math.max(1, width - swatchWidth - 1);
    return `${input.render(inputWidth)[0] ?? ""} ${swatch}`;
}

function truncateWithEllipsis(text: string, width: number): string {
    if (visibleWidth(text) <= width) return text;
    if (width <= 1) return truncateToWidth("…", Math.max(0, width), "");
    return `${truncateToWidth(text, width - 1, "")}…`;
}

function paddedLine(text: string, width: number): string {
    const truncated = truncateWithEllipsis(text, width);
    return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function rightAlignedLine(left: string, right: string, width: number): string {
    const rightWidth = visibleWidth(right);
    if (rightWidth >= width) return truncateToWidth(right, width, "");
    const leftLimit = Math.max(0, width - rightWidth - 1);
    const baseLine = truncateToWidth(left.replace(/ +$/u, ""), leftLimit, "");
    const gap = Math.max(1, width - visibleWidth(baseLine) - rightWidth);
    return `${baseLine}${" ".repeat(gap)}${right}`;
}

function border(theme: SettingsUiTheme, width: number): string {
    return theme.fg("border", "─".repeat(Math.max(1, width)));
}

function wrapInset(text: string, width: number): string[] {
    const inset = truncateToWidth("  ", width, "");
    const contentWidth = Math.max(1, width - visibleWidth(inset));
    return wrapTextWithAnsi(text, contentWidth).map((line) =>
        truncateToWidth(`${inset}${line}`, width, ""),
    );
}

/** Full-screen, tabbed editor for all discovered extension settings schemas. */
export class SettingsEditorComponent implements Component, Focusable {
    private activeTabIndex = 0;
    private activeScopeValue: "global" | "project" = "global";
    private selectedField = 0;
    private scrollOffset = 0;
    private editing: EditingField | undefined;
    private inlineEditing: InlineEditingField | undefined;
    private structuredEditing: StructuredEditing | undefined;
    private tabPicker: TabPicker | undefined;
    private valuePicker: ValuePicker | undefined;
    private statusMessage: string | undefined;
    private saving = false;
    private discardArmed = false;
    private _focused = false;

    constructor(private readonly options: SettingsEditorComponentOptions) {}

    get focused(): boolean {
        return this._focused;
    }

    set focused(value: boolean) {
        this._focused = value;
        if (this.editing !== undefined) this.editing.editor.focused = value;
        if (this.inlineEditing !== undefined) this.inlineEditing.input.focused = value;
        const structuredTextEditing = this.structuredEditing?.textEditing;
        if (structuredTextEditing?._tag === "StructuredFullTextEditing") {
            structuredTextEditing.editor.focused = value;
        } else if (structuredTextEditing?._tag === "StructuredInlineTextEditing") {
            structuredTextEditing.input.focused = value;
        }
    }

    handleInput(data: string): void {
        if (this.saving) return;
        if (this.valuePicker !== undefined) {
            this.handleValuePickerInput(data);
            return;
        }
        if (this.inlineEditing !== undefined) {
            this.handleInlineInput(data);
            return;
        }
        if (this.structuredEditing !== undefined) {
            this.handleStructuredInput(data);
            return;
        }
        if (this.editing !== undefined) {
            if (this.options.keybindings.matches(data, "tui.select.cancel")) {
                this.editing = undefined;
                this.statusMessage = "Edit cancelled.";
                this.options.tui.requestRender();
                return;
            }
            this.editing.editor.handleInput(data);
            this.options.tui.requestRender();
            return;
        }

        if (this.tabPicker !== undefined) {
            this.handleTabPickerInput(data);
            return;
        }

        if (matchesKey(data, Key.ctrl("p"))) {
            this.openTabPicker();
            return;
        }

        if (matchesKey(data, Key.tab)) {
            this.changeTab(1);
            return;
        }
        if (matchesKey(data, Key.shift("tab"))) {
            this.changeTab(-1);
            return;
        }
        if (matchesKey(data, Key.ctrl("g"))) {
            this.toggleScope();
            return;
        }
        if (this.activeTabIndex === 0) {
            if (!this.options.keybindings.matches(data, "tui.select.cancel")) {
                this.discardArmed = false;
            }
            this.options.piSettings.handleInput(data);
            return;
        }

        if (this.options.keybindings.matches(data, "tui.select.cancel")) {
            this.requestClose();
            return;
        }
        this.discardArmed = false;
        if (this.options.keybindings.matches(data, "tui.select.up")) {
            this.moveSelection(-1);
            return;
        }
        if (this.options.keybindings.matches(data, "tui.select.down")) {
            this.moveSelection(1);
            return;
        }
        if (this.options.keybindings.matches(data, "tui.select.pageUp")) {
            this.moveSelection(-this.visibleFieldCount());
            return;
        }
        if (this.options.keybindings.matches(data, "tui.select.pageDown")) {
            this.moveSelection(this.visibleFieldCount());
            return;
        }
        if (matchesKey(data, Key.delete) || matchesKey(data, Key.backspace)) {
            this.applyEdit(this.options.model.clearField(this.selectedField), "Override removed.");
            return;
        }

        const field = this.options.model.fields()[this.selectedField];
        if (field === undefined) return;
        if (matchesKey(data, Key.left)) {
            if (
                field.control._tag === "ChoiceControl" &&
                field.control.presentation === "segmented"
            ) {
                this.applyEdit(this.options.model.cycleChoice(this.selectedField, -1));
            } else if (field.control._tag === "BooleanControl") {
                this.applyEdit(this.options.model.setFieldValue(this.selectedField, false));
            } else if (
                field.control._tag === "NumberControl" &&
                field.control.presentation === "slider"
            ) {
                this.adjustMainSlider(-1);
            }
            return;
        }
        if (matchesKey(data, Key.right)) {
            if (
                field.control._tag === "ChoiceControl" &&
                field.control.presentation === "segmented"
            ) {
                this.applyEdit(this.options.model.cycleChoice(this.selectedField, 1));
            } else if (field.control._tag === "BooleanControl") {
                this.applyEdit(this.options.model.setFieldValue(this.selectedField, true));
            } else if (
                field.control._tag === "NumberControl" &&
                field.control.presentation === "slider"
            ) {
                this.adjustMainSlider(1);
            }
            return;
        }
        if (
            matchesKey(data, Key.space) ||
            this.options.keybindings.matches(data, "tui.select.confirm")
        ) {
            switch (field.control._tag) {
                case "BooleanControl":
                    this.applyEdit(this.options.model.toggleBoolean(this.selectedField));
                    break;
                case "ChoiceControl":
                    if (field.control.presentation === "segmented") {
                        this.applyEdit(this.options.model.cycleChoice(this.selectedField, 1));
                    } else {
                        this.openMainValuePicker(field);
                    }
                    break;
                case "JsonControl":
                case "NumberControl":
                    this.beginEdit();
                    break;
                case "TextControl":
                    if (field.control.presentation === "combobox") {
                        this.openMainValuePicker(field);
                    } else {
                        this.beginEdit();
                    }
                    break;
                case "ListControl":
                case "MapControl":
                case "ObjectControl":
                case "UnionControl":
                    this.beginStructuredEdit();
                    break;
                case "NullControl":
                    this.statusMessage = "This setting only accepts null.";
                    this.options.tui.requestRender();
                    break;
                case "ReadOnlyControl":
                    this.statusMessage = field.control.reason;
                    this.options.tui.requestRender();
                    break;
            }
        }
    }

    invalidate(): void {
        this.options.piSettings.invalidate();
        this.editing?.editor.invalidate();
        this.inlineEditing?.input.invalidate();
        const structuredTextEditing = this.structuredEditing?.textEditing;
        if (structuredTextEditing?._tag === "StructuredFullTextEditing") {
            structuredTextEditing.editor.invalidate();
        } else if (structuredTextEditing?._tag === "StructuredInlineTextEditing") {
            structuredTextEditing.input.invalidate();
        }
    }

    render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        const lines = [...this.renderHeader(safeWidth)];

        if (this.tabPicker !== undefined) {
            lines.push(...this.renderTabPicker(safeWidth));
            return lines.map((line) => truncateToWidth(line, safeWidth, ""));
        }

        if (this.valuePicker !== undefined) {
            lines.push(...this.renderValuePicker(safeWidth));
            return lines.map((line) => truncateToWidth(line, safeWidth, ""));
        }

        if (this.activeTabIndex === 0) {
            lines.push(...this.options.piSettings.render(safeWidth));
            if (this.statusMessage !== undefined) {
                lines.push(
                    ...wrapInset(this.options.theme.fg("warning", this.statusMessage), safeWidth),
                );
            }
            return lines.map((line) => truncateToWidth(line, safeWidth, ""));
        }

        lines.push(border(this.options.theme, safeWidth));

        if (this.options.model.extensionCount === 0) {
            lines.push(
                ...wrapInset(
                    this.options.theme.fg(
                        "warning",
                        "No generated extension settings schemas were found.",
                    ),
                    safeWidth,
                ),
            );
        } else if (this.editing !== undefined) {
            lines.push(...this.renderEditing(safeWidth));
        } else if (this.structuredEditing !== undefined) {
            lines.push(...this.renderStructuredEditing(safeWidth));
        } else {
            lines.push(...this.renderFields(safeWidth));
        }

        if (this.statusMessage !== undefined) {
            lines.push(...wrapInset(this.options.theme.fg("muted", this.statusMessage), safeWidth));
        }
        const canChange =
            this.options.model.scopeView(this.options.model.activeScope).editable &&
            this.options.model
                .fields()
                .some(
                    (field) =>
                        field.control._tag !== "ReadOnlyControl" &&
                        field.control._tag !== "NullControl",
                );
        const structuredTextEditing = this.structuredEditing?.textEditing;
        const help =
            this.editing !== undefined ||
            this.inlineEditing !== undefined ||
            structuredTextEditing !== undefined
                ? "Enter apply • Esc cancel"
                : this.structuredEditing !== undefined
                  ? "Enter change • Del remove • Esc back"
                  : canChange
                    ? "Tab switch • Ctrl+P choose • Ctrl+G scope • Enter change • Esc close"
                    : "Tab switch • Ctrl+P choose • Ctrl+G scope • Esc close";
        lines.push(...wrapInset(this.options.theme.fg("dim", help), safeWidth));
        lines.push(border(this.options.theme, safeWidth));
        return lines.map((line) => truncateToWidth(line, safeWidth, ""));
    }

    private renderHeader(width: number): string[] {
        const title = this.options.theme.fg("accent", this.options.theme.bold("Settings"));
        const navigation = this.renderNavigation();
        const scope = this.renderScope();
        const combined = `${title}  ${navigation}  ${scope}`;
        let lines: string[];
        if (visibleWidth(combined) <= width) {
            lines = [combined];
        } else {
            const primary = `${title}  ${navigation}`;
            lines =
                visibleWidth(primary) <= width
                    ? [primary, truncateToWidth(scope, width, "")]
                    : [
                          truncateToWidth(title, width, ""),
                          truncateToWidth(navigation, width, ""),
                          truncateToWidth(scope, width, ""),
                      ];
        }

        const counter = this.activeFieldCounter();
        if (counter !== undefined && lines[0] !== undefined) {
            lines[0] = rightAlignedLine(lines[0], this.options.theme.fg("dim", counter), width);
        }
        return lines;
    }

    private activeFieldCounter(): string | undefined {
        if (
            this.activeTabIndex === 0 ||
            this.tabPicker !== undefined ||
            this.valuePicker !== undefined
        )
            return undefined;
        if (this.structuredEditing !== undefined) {
            const rows = this.currentStructuredRows();
            if (rows.length === 0) return undefined;
            return `(${Math.min(this.structuredEditing.selectedRow + 1, rows.length)}/${rows.length})`;
        }
        const count = this.options.model.fields().length;
        if (count === 0) return undefined;
        return `(${Math.min(this.selectedField + 1, count)}/${count})`;
    }

    private renderNavigation(): string {
        const tabs = this.options.model.tabs();
        const selected = (text: string): string =>
            this.options.theme.bg(
                "selectedBg",
                this.options.theme.fg("accent", this.options.theme.bold(` ${text} `)),
            );
        let activeTitle = "Pi";
        if (this.activeTabIndex > 0) {
            const tab = tabs[this.activeTabIndex - 1];
            const marker =
                tab === undefined ? "" : `${tab.dirty ? "*" : ""}${tab.blocked ? "!" : ""}`;
            const title = tab === undefined ? "Extension" : compactExtensionTitle(tab.title);
            activeTitle = `${title}${marker}`;
        }
        const choose = this.options.theme.fg("dim", "  Ctrl+P");
        return `${selected(activeTitle)}${choose}`;
    }

    private renderTabPicker(width: number): string[] {
        const picker = this.tabPicker;
        if (picker === undefined) return [];
        const choices = this.filteredTabChoices(picker.query);
        const visibleCount = Math.max(4, Math.min(12, this.options.tui.terminal.rows - 9));
        const maxOffset = Math.max(0, choices.length - visibleCount);
        picker.scrollOffset = Math.min(picker.scrollOffset, maxOffset);
        if (picker.selectedIndex < picker.scrollOffset) {
            picker.scrollOffset = picker.selectedIndex;
        }
        if (picker.selectedIndex >= picker.scrollOffset + visibleCount) {
            picker.scrollOffset = picker.selectedIndex - visibleCount + 1;
        }

        const lines = [
            border(this.options.theme, width),
            this.options.theme.fg("accent", this.options.theme.bold("Choose settings tab")),
            rightAlignedLine(
                `› ${picker.query}`,
                this.options.theme.fg(
                    "dim",
                    `(${choices.length === 0 ? 0 : Math.min(picker.selectedIndex + 1, choices.length)}/${choices.length})`,
                ),
                width,
            ),
        ];
        const visible = choices.slice(picker.scrollOffset, picker.scrollOffset + visibleCount);
        for (const [offset, choice] of visible.entries()) {
            const index = picker.scrollOffset + offset;
            const marker = `${choice.dirty ? " *" : ""}${choice.blocked ? " !" : ""}`;
            const label = `${choice.title}${marker}`;
            const selected = index === picker.selectedIndex;
            const prefix = selected ? this.options.theme.fg("accent", "▎") : " ";
            const text = this.options.theme.fg(selected ? "accent" : "text", label);
            lines.push(truncateToWidth(`${prefix} ${text}`, width, ""));
        }
        if (choices.length === 0) {
            lines.push(this.options.theme.fg("muted", "  No matching settings tabs."));
        }
        lines.push(
            border(this.options.theme, width),
            this.options.theme.fg("dim", "Type to filter • ↑↓ move • Enter select • Esc cancel"),
        );
        return lines;
    }

    private renderValuePicker(width: number): string[] {
        const picker = this.valuePicker;
        if (picker === undefined) return [];
        const choices = this.filteredValuePickerOptions(picker);
        picker.selectedIndex = Math.max(
            0,
            Math.min(Math.max(0, choices.length - 1), picker.selectedIndex),
        );
        const visibleCount = Math.max(4, Math.min(12, this.options.tui.terminal.rows - 9));
        const maxOffset = Math.max(0, choices.length - visibleCount);
        picker.scrollOffset = Math.min(picker.scrollOffset, maxOffset);
        if (picker.selectedIndex < picker.scrollOffset) {
            picker.scrollOffset = picker.selectedIndex;
        }
        if (picker.selectedIndex >= picker.scrollOffset + visibleCount) {
            picker.scrollOffset = picker.selectedIndex - visibleCount + 1;
        }

        const lines = [
            border(this.options.theme, width),
            this.options.theme.fg(
                "accent",
                this.options.theme.bold(`Choose ${picker.title.toLocaleLowerCase()}`),
            ),
            rightAlignedLine(
                `› ${picker.query}`,
                this.options.theme.fg(
                    "dim",
                    `(${choices.length === 0 ? 0 : Math.min(picker.selectedIndex + 1, choices.length)}/${choices.length})`,
                ),
                width,
            ),
        ];
        const visible = choices.slice(picker.scrollOffset, picker.scrollOffset + visibleCount);
        for (const [offset, choice] of visible.entries()) {
            const index = picker.scrollOffset + offset;
            const selected = index === picker.selectedIndex;
            const prefix = selected ? this.options.theme.fg("accent", "▎") : " ";
            const label = choice._tag === "CustomValue" ? `Use “${choice.label}”` : choice.label;
            const text = this.options.theme.fg(selected ? "accent" : "text", label);
            lines.push(truncateToWidth(`${prefix} ${text}`, width, ""));
        }
        if (choices.length === 0) {
            const empty = picker.allowCustom ? "Type a custom value." : "No matching choices.";
            lines.push(this.options.theme.fg("muted", `  ${empty}`));
        }
        if (picker.error !== undefined) {
            lines.push(...wrapInset(this.options.theme.fg("error", picker.error), width));
        }
        lines.push(
            border(this.options.theme, width),
            this.options.theme.fg("dim", "Type to filter • ↑↓ move • Enter select • Esc cancel"),
        );
        return lines;
    }

    private renderScope(): string {
        const active = this.activeScopeValue;
        const scopeTitle = this.options.theme.fg("dim", "Scope:");
        const globalAvailable =
            this.activeTabIndex === 0
                ? this.options.piSettings.scopeAvailable("global")
                : this.options.model.scopeView("global").available;
        const projectAvailable =
            this.activeTabIndex === 0
                ? this.options.piSettings.scopeAvailable("project")
                : this.options.model.scopeView("project").available;
        const scopeLabel = (label: string, selected: boolean, available: boolean): string => {
            if (!available) return this.options.theme.fg("dim", ` ${label} `);
            return selected
                ? this.options.theme.bg(
                      "selectedBg",
                      this.options.theme.fg("accent", this.options.theme.bold(` ${label} `)),
                  )
                : this.options.theme.fg("muted", ` ${label} `);
        };
        return `${scopeTitle} ${scopeLabel("Global", active === "global", globalAvailable)} ${scopeLabel("Project", active === "project", projectAvailable)}`;
    }

    private renderFields(width: number): string[] {
        const scope = this.options.model.scopeView(this.options.model.activeScope);
        if (!scope.editable) {
            return wrapInset(this.options.theme.fg("warning", scope.message), width);
        }
        const fields = this.options.model.fields();
        if (fields.length === 0)
            return wrapInset(this.options.theme.fg("dim", "No user-editable settings."), width);

        const visibleCount = this.visibleFieldCount();
        const maxOffset = Math.max(0, fields.length - visibleCount);
        this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
        if (this.selectedField < this.scrollOffset) this.scrollOffset = this.selectedField;
        if (this.selectedField >= this.scrollOffset + visibleCount) {
            this.scrollOffset = this.selectedField - visibleCount + 1;
        }

        const lines: string[] = [];
        const visible = fields.slice(this.scrollOffset, this.scrollOffset + visibleCount);
        const extensionTitle =
            this.options.model.tabs()[Math.max(0, this.activeTabIndex - 1)]?.title ?? "";
        const categoryCount = visible.reduce((count, field, index) => {
            const group = fieldGroup(field, extensionTitle);
            const previous = visible[index - 1];
            return group !== "" &&
                (previous === undefined || group !== fieldGroup(previous, extensionTitle))
                ? count + 1
                : count;
        }, 0);
        const listPreviewBudget = Math.max(
            2,
            Math.min(12, this.options.tui.terminal.rows - 10 - visible.length - categoryCount * 2),
        );
        const maxLabelWidth = Math.max(1, width - 12);
        const minLabelWidth = Math.min(12, maxLabelWidth);
        const labelWidth = Math.min(
            maxLabelWidth,
            Math.max(minLabelWidth, ...visible.map((field) => visibleWidth(field.label))),
        );
        let previousGroup: string | undefined;
        for (const [offset, field] of visible.entries()) {
            const index = this.scrollOffset + offset;
            const group = fieldGroup(field, extensionTitle);
            if (group !== "" && group !== previousGroup) {
                lines.push("");
                lines.push(
                    truncateToWidth(
                        `  ${this.options.theme.fg("muted", this.options.theme.bold(group))}`,
                        width,
                        "",
                    ),
                );
            }
            previousGroup = group;
            const selected = index === this.selectedField;
            const prefix = selected ? this.options.theme.fg("accent", "▎") : " ";
            const label = paddedLine(field.label, labelWidth);
            const valueWidth = Math.max(1, width - labelWidth - 4);
            const color = selected ? "accent" : field.overridden ? "text" : "muted";
            const inlineEditing = this.inlineEditing;
            const inlineValue =
                inlineEditing?.fieldIndex === index
                    ? renderInlineControl(inlineEditing.input, field.control, valueWidth)
                    : undefined;
            const value =
                inlineValue ??
                this.options.theme.fg(color, truncateWithEllipsis(displayValue(field), valueWidth));
            const row = `${prefix} ${this.options.theme.fg(color, label)}  ${value}`;
            lines.push(truncateToWidth(row, width, ""));
            if (selected && inlineValue === undefined) {
                lines.push(
                    ...renderCollectionPreview(field, width, listPreviewBudget, this.options.theme),
                );
            }
        }

        const selected = fields[this.selectedField];
        if (selected !== undefined) {
            const origin = selected.overridden
                ? `${this.options.model.activeScope === "global" ? "Global" : "Project"} override; Delete restores the inherited or default value.`
                : "Inherited or default value.";
            const requirement = selected.required ? " Required setting." : "";
            const details =
                selected.constraints === ""
                    ? `${selected.description} ${origin}${requirement}`
                    : `${selected.description} ${origin}${requirement} (${selected.constraints})`;
            const guidance = controlGuidance(selected.control);
            lines.push("");
            lines.push(
                ...wrapInset(
                    this.options.theme.fg(
                        "dim",
                        guidance === "" ? details : `${details} ${guidance}`,
                    ),
                    width,
                ),
            );
            if (this.inlineEditing?.error !== undefined) {
                lines.push(
                    ...wrapInset(this.options.theme.fg("error", this.inlineEditing.error), width),
                );
            }
        }
        return lines;
    }

    private currentStructuredRows(): readonly StructuredEditorRow[] {
        const state = this.structuredEditing;
        if (state === undefined) return [];
        const field = this.options.model.fields()[state.fieldIndex];
        return field === undefined
            ? []
            : buildStructuredRows(structuredNodeForField(field), field.value);
    }

    private renderStructuredEditing(width: number): string[] {
        const state = this.structuredEditing;
        if (state === undefined) return [];
        const field = this.options.model.fields()[state.fieldIndex];
        if (field === undefined) {
            return wrapInset(this.options.theme.fg("error", "The setting disappeared."), width);
        }
        const rows = this.currentStructuredRows();
        state.selectedRow = Math.max(0, Math.min(Math.max(0, rows.length - 1), state.selectedRow));

        const textEditing = state.textEditing;
        if (textEditing?._tag === "StructuredFullTextEditing") {
            const row = rows[textEditing.rowIndex];
            const label = row === undefined ? field.label : structuredRowLabel(row);
            const description =
                textEditing.mode === "rename"
                    ? "Rename this map entry."
                    : row?._tag === "ValueRow"
                      ? row.node.description
                      : field.description;
            const lines = [
                truncateToWidth(
                    `  ${this.options.theme.fg("accent", this.options.theme.bold(`${field.label} › ${label}`))}`,
                    width,
                ),
                "",
                ...wrapInset(this.options.theme.fg("dim", description), width),
                ...textEditing.editor.render(width),
            ];
            if (textEditing.error !== undefined) {
                lines.push(...wrapInset(this.options.theme.fg("error", textEditing.error), width));
            }
            return lines;
        }

        const lines = [
            truncateToWidth(
                `  ${this.options.theme.fg("accent", this.options.theme.bold(field.label))}`,
                width,
            ),
            "",
            ...wrapInset(this.options.theme.fg("dim", field.description), width),
            "",
        ];
        if (rows.length === 0) {
            lines.push(
                ...wrapInset(this.options.theme.fg("muted", "No structured values."), width),
            );
            return lines;
        }

        const visibleCount = Math.max(4, this.options.tui.terminal.rows - 14);
        const maxOffset = Math.max(0, rows.length - visibleCount);
        state.scrollOffset = Math.min(state.scrollOffset, maxOffset);
        if (state.selectedRow < state.scrollOffset) state.scrollOffset = state.selectedRow;
        if (state.selectedRow >= state.scrollOffset + visibleCount) {
            state.scrollOffset = state.selectedRow - visibleCount + 1;
        }
        const visibleRows = rows.slice(state.scrollOffset, state.scrollOffset + visibleCount);
        const maxLabelWidth = Math.max(1, width - 12);
        const labelWidth = Math.min(
            maxLabelWidth,
            Math.max(
                12,
                ...visibleRows.map((row) =>
                    row._tag === "GroupRow"
                        ? 0
                        : visibleWidth(structuredRowLabel(row)) + Math.max(0, row.depth - 1) * 2,
                ),
            ),
        );
        for (const [offset, row] of visibleRows.entries()) {
            const index = state.scrollOffset + offset;
            const selected = index === state.selectedRow;
            const prefix = selected ? this.options.theme.fg("accent", "▎") : " ";
            const indentation = "  ".repeat(Math.max(0, row.depth - 1));
            const inlineEditing =
                textEditing?._tag === "StructuredInlineTextEditing" &&
                textEditing.rowIndex === index
                    ? textEditing
                    : undefined;
            const rowColor =
                selected || row._tag === "AddRow"
                    ? "accent"
                    : row._tag === "GroupRow"
                      ? "text"
                      : "muted";
            if (row._tag === "GroupRow") {
                if (inlineEditing !== undefined) {
                    const inputWidth = Math.max(
                        1,
                        width - visibleWidth(prefix) - 2 - indentation.length,
                    );
                    const input = inlineEditing.input.render(inputWidth)[0] ?? "";
                    lines.push(truncateToWidth(`${prefix} ${indentation}${input}`, width, ""));
                    continue;
                }
                const summary = structuredRowValue(row);
                const content = `${indentation}${structuredRowLabel(row)}${summary === "" ? "" : `  ${summary}`}`;
                lines.push(
                    truncateToWidth(
                        `${prefix} ${this.options.theme.fg(rowColor, content)}`,
                        width,
                        "",
                    ),
                );
                continue;
            }
            const label = paddedLine(`${indentation}${structuredRowLabel(row)}`, labelWidth);
            const valueWidth = Math.max(1, width - labelWidth - 4);
            const value =
                inlineEditing === undefined
                    ? this.options.theme.fg(
                          rowColor,
                          truncateWithEllipsis(structuredDisplayValue(row), valueWidth),
                      )
                    : row._tag === "ValueRow"
                      ? renderInlineControl(inlineEditing.input, row.node.control, valueWidth)
                      : (inlineEditing.input.render(valueWidth)[0] ?? "");
            lines.push(
                truncateToWidth(
                    `${prefix} ${this.options.theme.fg(rowColor, label)}  ${value}`,
                    width,
                    "",
                ),
            );
        }

        const selected = rows[state.selectedRow];
        if (selected !== undefined) {
            let details: string;
            switch (selected._tag) {
                case "AddRow":
                    details = "Create a schema-shaped entry with safe initial values.";
                    break;
                case "GroupRow":
                    details = selected.renameable
                        ? "Enter renames this map key; Delete removes the entry."
                        : selected.remove === undefined
                          ? "Structured group."
                          : "Delete removes this entry.";
                    break;
                case "ValueRow": {
                    details =
                        selected.node.constraints === ""
                            ? selected.node.description
                            : `${selected.node.description} (${selected.node.constraints})`;
                    const guidance = controlGuidance(selected.node.control);
                    if (guidance !== "") details = `${details} ${guidance}`;
                    break;
                }
                case "VariantRow":
                    details = "Choose which schema variant this value uses.";
                    break;
            }
            lines.push("");
            lines.push(...wrapInset(this.options.theme.fg("dim", details), width));
            if (textEditing?.error !== undefined) {
                lines.push(...wrapInset(this.options.theme.fg("error", textEditing.error), width));
            }
        }
        return lines;
    }

    private renderEditing(width: number): string[] {
        const editing = this.editing;
        if (editing === undefined) return [];
        const field = this.options.model.fields()[editing.fieldIndex];
        if (field === undefined)
            return wrapInset(this.options.theme.fg("error", "The setting disappeared."), width);
        const lines = [
            truncateToWidth(
                `  ${this.options.theme.fg("accent", this.options.theme.bold(field.path.join(" › ")))}`,
                width,
            ),
            "",
            ...wrapInset(this.options.theme.fg("dim", field.description), width),
            ...editing.editor.render(width),
        ];
        if (editing.error !== undefined) {
            lines.push(...wrapInset(this.options.theme.fg("error", editing.error), width));
        }
        return lines;
    }

    private handleInlineInput(data: string): void {
        const editing = this.inlineEditing;
        if (editing === undefined) return;
        if (this.options.keybindings.matches(data, "tui.select.cancel")) {
            this.inlineEditing = undefined;
            this.statusMessage = "Edit cancelled.";
            this.options.tui.requestRender();
            return;
        }
        const field = this.options.model.fields()[editing.fieldIndex];
        if (
            matchesKey(data, Key.tab) &&
            field?.control._tag === "TextControl" &&
            field.control.presentation === "path"
        ) {
            this.completePathInput(editing.input);
            return;
        }
        editing.input.handleInput(data);
        this.options.tui.requestRender();
    }

    private handleStructuredInput(data: string): void {
        const state = this.structuredEditing;
        if (state === undefined) return;
        const textEditing = state.textEditing;
        if (textEditing !== undefined) {
            if (this.options.keybindings.matches(data, "tui.select.cancel")) {
                state.textEditing = undefined;
                this.statusMessage = "Edit cancelled.";
                this.options.tui.requestRender();
                return;
            }
            if (textEditing._tag === "StructuredFullTextEditing") {
                textEditing.editor.handleInput(data);
            } else {
                const rows = this.currentStructuredRows();
                const row = rows[textEditing.rowIndex];
                if (
                    matchesKey(data, Key.tab) &&
                    row?._tag === "ValueRow" &&
                    row.node.control._tag === "TextControl" &&
                    row.node.control.presentation === "path"
                ) {
                    this.completePathInput(textEditing.input);
                    return;
                }
                textEditing.input.handleInput(data);
            }
            this.options.tui.requestRender();
            return;
        }

        if (this.options.keybindings.matches(data, "tui.select.cancel")) {
            this.structuredEditing = undefined;
            this.statusMessage = undefined;
            this.options.tui.requestRender();
            return;
        }
        const rows = this.currentStructuredRows();
        if (this.options.keybindings.matches(data, "tui.select.up")) {
            this.moveStructuredSelection(-1, rows.length);
            return;
        }
        if (this.options.keybindings.matches(data, "tui.select.down")) {
            this.moveStructuredSelection(1, rows.length);
            return;
        }
        if (this.options.keybindings.matches(data, "tui.select.pageUp")) {
            this.moveStructuredSelection(
                -Math.max(4, this.options.tui.terminal.rows - 14),
                rows.length,
            );
            return;
        }
        if (this.options.keybindings.matches(data, "tui.select.pageDown")) {
            this.moveStructuredSelection(
                Math.max(4, this.options.tui.terminal.rows - 14),
                rows.length,
            );
            return;
        }
        const row = rows[state.selectedRow];
        if (row === undefined) return;
        if (matchesKey(data, Key.delete) || matchesKey(data, Key.backspace)) {
            if (row._tag === "GroupRow" || row._tag === "ValueRow") {
                const field = this.options.model.fields()[state.fieldIndex];
                this.applyStructuredOutcome(
                    removeStructuredEntry(field?.value, row),
                    "Entry removed.",
                );
            } else {
                this.statusMessage = "The selected row is not removable.";
                this.options.tui.requestRender();
            }
            return;
        }
        if (matchesKey(data, Key.left)) {
            this.activateStructuredRow(row, -1, false);
            return;
        }
        if (matchesKey(data, Key.right)) {
            this.activateStructuredRow(row, 1, true);
            return;
        }
        if (
            matchesKey(data, Key.space) ||
            this.options.keybindings.matches(data, "tui.select.confirm")
        ) {
            this.activateStructuredRow(row, 1, undefined);
        }
    }

    private moveStructuredSelection(offset: number, rowCount: number): void {
        const state = this.structuredEditing;
        if (state === undefined || rowCount === 0) return;
        state.selectedRow = Math.max(0, Math.min(rowCount - 1, state.selectedRow + offset));
        this.statusMessage = undefined;
        this.options.tui.requestRender();
    }

    private activateStructuredRow(
        row: StructuredEditorRow,
        offset: number,
        booleanValue: boolean | undefined,
    ): void {
        const state = this.structuredEditing;
        if (state === undefined) return;
        const field = this.options.model.fields()[state.fieldIndex];
        const root = field?.value;
        switch (row._tag) {
            case "AddRow":
                if (booleanValue === undefined) {
                    this.applyStructuredOutcome(addStructuredEntry(root, row), "Entry added.");
                }
                return;
            case "GroupRow":
                if (booleanValue === undefined && row.renameable) {
                    this.beginStructuredTextEdit(row, "rename");
                } else if (booleanValue === undefined) {
                    this.statusMessage =
                        row.remove === undefined
                            ? "This row groups nested settings."
                            : "Use Delete to remove this entry.";
                    this.options.tui.requestRender();
                }
                return;
            case "VariantRow":
                this.applyStructuredOutcome(
                    cycleStructuredVariant(root, row, offset),
                    "Value type changed.",
                );
                return;
            case "ValueRow":
                break;
        }

        switch (row.node.control._tag) {
            case "BooleanControl": {
                const next = booleanValue ?? row.value !== true;
                this.applyStructuredOutcome(
                    {
                        _tag: "StructuredValueChanged",
                        value: setStructuredValueAtPath(root, row.path, next),
                    },
                    "Setting updated.",
                );
                return;
            }
            case "ChoiceControl": {
                if (row.node.control.presentation !== "segmented") {
                    if (booleanValue === undefined) this.openStructuredValuePicker(row);
                    return;
                }
                const choices = row.node.control.choices;
                const currentIndex = choices.findIndex((choice) => Object.is(choice, row.value));
                const index =
                    currentIndex === -1
                        ? offset < 0
                            ? choices.length - 1
                            : 0
                        : (currentIndex + offset + choices.length) % choices.length;
                const choice = choices[index];
                if (choice === undefined) {
                    this.statusMessage = "This setting has no available choices.";
                    this.options.tui.requestRender();
                    return;
                }
                this.applyStructuredOutcome(
                    {
                        _tag: "StructuredValueChanged",
                        value: setStructuredValueAtPath(root, row.path, choice),
                    },
                    "Setting updated.",
                );
                return;
            }
            case "JsonControl":
                if (booleanValue === undefined) this.beginStructuredTextEdit(row, "value");
                return;
            case "NumberControl":
                if (row.node.control.presentation === "slider" && booleanValue !== undefined) {
                    const current = typeof row.value === "number" ? row.value : undefined;
                    const next = stepSettingsNumber(row.node.control, current, offset < 0 ? -1 : 1);
                    this.applyStructuredOutcome(
                        {
                            _tag: "StructuredValueChanged",
                            value: setStructuredValueAtPath(root, row.path, next),
                        },
                        "Setting updated.",
                    );
                } else if (booleanValue === undefined) {
                    this.beginStructuredTextEdit(row, "value");
                }
                return;
            case "TextControl":
                if (booleanValue !== undefined) return;
                if (row.node.control.presentation === "combobox") {
                    this.openStructuredValuePicker(row);
                } else {
                    this.beginStructuredTextEdit(row, "value");
                }
                return;
            case "ReadOnlyControl":
                this.statusMessage = row.node.control.reason;
                this.options.tui.requestRender();
                return;
            case "NullControl":
                this.statusMessage = "This value only accepts null.";
                this.options.tui.requestRender();
                return;
            case "ListControl":
            case "MapControl":
            case "ObjectControl":
            case "UnionControl":
                this.statusMessage = "Choose one of this value's nested rows.";
                this.options.tui.requestRender();
        }
    }

    private applyStructuredOutcome(
        outcome: StructuredValueOutcome,
        successMessage: string,
    ): boolean {
        const state = this.structuredEditing;
        if (state === undefined) return false;
        if (outcome._tag === "StructuredValueRejected") {
            this.statusMessage = outcome.message;
            this.options.tui.requestRender();
            return false;
        }
        const edited = this.options.model.setFieldValue(state.fieldIndex, outcome.value);
        if (edited._tag === "EditRejected") {
            this.statusMessage = edited.message;
            this.options.tui.requestRender();
            return false;
        }
        this.statusMessage = successMessage;
        this.startSave();
        return true;
    }

    private beginStructuredTextEdit(
        row: Extract<StructuredEditorRow, { readonly _tag: "GroupRow" | "ValueRow" }>,
        mode: StructuredTextEditing["mode"],
    ): void {
        const state = this.structuredEditing;
        if (state === undefined) return;
        const rowIndex = state.selectedRow;
        const submit = (text: string) => {
            const currentState = this.structuredEditing;
            if (currentState === undefined) return;
            const currentRows = this.currentStructuredRows();
            const currentRow = currentRows[rowIndex];
            const field = this.options.model.fields()[currentState.fieldIndex];
            if (
                field === undefined ||
                currentRow === undefined ||
                (currentRow._tag !== "GroupRow" && currentRow._tag !== "ValueRow")
            ) {
                currentState.textEditing = undefined;
                this.statusMessage = "The structured value changed while it was being edited.";
                this.options.tui.requestRender();
                return;
            }
            let outcome: StructuredValueOutcome;
            if (mode === "rename" && currentRow._tag === "GroupRow") {
                outcome = renameStructuredMapEntry(field.value, currentRow, text);
            } else if (currentRow._tag === "ValueRow") {
                const parsed = parseStructuredInput(currentRow.node, text);
                if (parsed._tag === "StructuredInputRejected") {
                    const activeEditor = currentState.textEditing;
                    if (activeEditor !== undefined) activeEditor.error = parsed.message;
                    this.options.tui.requestRender();
                    return;
                }
                outcome = {
                    _tag: "StructuredValueChanged",
                    value: setStructuredValueAtPath(field.value, currentRow.path, parsed.value),
                };
            } else {
                outcome = {
                    _tag: "StructuredValueRejected",
                    message: "The selected row cannot be edited as text.",
                };
            }
            if (
                this.applyStructuredOutcome(
                    outcome,
                    mode === "rename" ? "Entry renamed." : "Setting updated.",
                )
            ) {
                currentState.textEditing = undefined;
            } else {
                const activeEditor = currentState.textEditing;
                if (activeEditor !== undefined) activeEditor.error = this.statusMessage;
            }
            this.options.tui.requestRender();
        };
        const inline =
            mode === "rename" ||
            (row._tag === "ValueRow" &&
                (row.node.control._tag === "NumberControl" ||
                    (row.node.control._tag === "TextControl" &&
                        row.node.control.editor === "inline" &&
                        !(typeof row.value === "string" && row.value.includes("\n")))));
        if (inline) {
            const input = new Input();
            input.setValue(initialStructuredInput(row));
            input.focused = this._focused;
            input.onSubmit = submit;
            state.textEditing = {
                _tag: "StructuredInlineTextEditing",
                mode,
                rowIndex,
                input,
                error: undefined,
            };
        } else {
            const editor = new Editor(this.options.tui, {
                borderColor: (text) => this.options.theme.fg("accent", text),
                selectList: getSelectListTheme(),
            });
            editor.setText(initialStructuredInput(row));
            editor.focused = this._focused;
            editor.onSubmit = submit;
            state.textEditing = {
                _tag: "StructuredFullTextEditing",
                mode,
                rowIndex,
                editor,
                error: undefined,
            };
        }
        this.statusMessage = undefined;
        this.options.tui.requestRender();
    }

    private visibleFieldCount(): number {
        const selected = this.options.model.fields()[this.selectedField];
        const reservesPreview =
            selected?.control._tag === "ListControl" ||
            isJsonArray(selected?.value) ||
            isJsonObject(selected?.value);
        return Math.max(3, this.options.tui.terminal.rows - (reservesPreview ? 19 : 15));
    }

    private moveSelection(offset: number): void {
        const fieldCount = this.options.model.fields().length;
        if (fieldCount === 0) return;
        this.selectedField = Math.max(0, Math.min(fieldCount - 1, this.selectedField + offset));
        this.statusMessage = undefined;
        this.options.tui.requestRender();
    }

    private changeTab(offset: number): void {
        const tabCount = this.options.model.extensionCount + 1;
        this.selectTab((this.activeTabIndex + offset + tabCount) % tabCount);
    }

    private selectTab(tabIndex: number): void {
        if (tabIndex < 0 || tabIndex > this.options.model.extensionCount) return;
        if (this.activeTabIndex === 0 && tabIndex !== 0) this.options.piSettings.leave();
        this.activeTabIndex = tabIndex;
        if (tabIndex === 0) {
            if (!this.options.piSettings.selectScope(this.activeScopeValue)) {
                this.activeScopeValue = "global";
                this.options.piSettings.selectScope("global");
            }
        } else {
            this.options.model.selectExtension(tabIndex - 1);
            if (!this.options.model.selectScope(this.activeScopeValue)) {
                this.activeScopeValue = "global";
                this.options.model.selectScope("global");
            }
        }
        this.selectedField = 0;
        this.scrollOffset = 0;
        this.editing = undefined;
        this.inlineEditing = undefined;
        this.structuredEditing = undefined;
        this.valuePicker = undefined;
        this.statusMessage = undefined;
        this.discardArmed = false;
        this.options.tui.requestRender();
    }

    private tabChoices(): readonly TabChoice[] {
        return [
            { tabIndex: 0, title: "Pi", dirty: false, blocked: false },
            ...this.options.model.tabs().map((tab, index) => ({
                tabIndex: index + 1,
                title: compactExtensionTitle(tab.title),
                dirty: tab.dirty,
                blocked: tab.blocked,
            })),
        ];
    }

    private filteredTabChoices(query: string): readonly TabChoice[] {
        const normalized = query.trim().toLocaleLowerCase();
        if (normalized === "") return this.tabChoices();
        return this.tabChoices().filter((choice) =>
            choice.title.toLocaleLowerCase().includes(normalized),
        );
    }

    private openTabPicker(): void {
        this.tabPicker = {
            query: "",
            selectedIndex: this.activeTabIndex,
            scrollOffset: 0,
        };
        this.statusMessage = undefined;
        this.options.tui.requestRender();
    }

    private handleTabPickerInput(data: string): void {
        const picker = this.tabPicker;
        if (picker === undefined) return;
        if (this.options.keybindings.matches(data, "tui.select.cancel")) {
            this.tabPicker = undefined;
            this.options.tui.requestRender();
            return;
        }
        const choices = this.filteredTabChoices(picker.query);
        if (this.options.keybindings.matches(data, "tui.select.up")) {
            if (choices.length > 0) {
                picker.selectedIndex = (picker.selectedIndex - 1 + choices.length) % choices.length;
            }
        } else if (this.options.keybindings.matches(data, "tui.select.down")) {
            if (choices.length > 0) {
                picker.selectedIndex = (picker.selectedIndex + 1) % choices.length;
            }
        } else if (this.options.keybindings.matches(data, "tui.select.pageUp")) {
            picker.selectedIndex = Math.max(0, picker.selectedIndex - 10);
        } else if (this.options.keybindings.matches(data, "tui.select.pageDown")) {
            picker.selectedIndex = Math.min(
                Math.max(0, choices.length - 1),
                picker.selectedIndex + 10,
            );
        } else if (this.options.keybindings.matches(data, "tui.select.confirm")) {
            const choice = choices[picker.selectedIndex];
            if (choice !== undefined) {
                this.tabPicker = undefined;
                this.selectTab(choice.tabIndex);
                return;
            }
        } else if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
            picker.query = Array.from(picker.query).slice(0, -1).join("");
            picker.selectedIndex = 0;
            picker.scrollOffset = 0;
        } else if (isPrintableText(data)) {
            picker.query += data;
            picker.selectedIndex = 0;
            picker.scrollOffset = 0;
        }
        this.options.tui.requestRender();
    }

    private filteredValuePickerOptions(picker: ValuePicker): readonly FilteredValuePickerOption[] {
        const normalized = picker.query.toLocaleLowerCase();
        const options: FilteredValuePickerOption[] = picker.options
            .filter(
                (option) =>
                    normalized === "" ||
                    option.label.toLocaleLowerCase().includes(normalized) ||
                    String(option.value).toLocaleLowerCase().includes(normalized),
            )
            .map((option) => ({ ...option, _tag: "SchemaValue" }));
        const hasExactValue = picker.options.some(
            (option) => typeof option.value === "string" && option.value === picker.query,
        );
        if (picker.allowCustom && picker.query !== "" && !hasExactValue) {
            options.unshift({
                _tag: "CustomValue",
                label: picker.query,
                value: picker.query,
            });
        }
        return options;
    }

    private openMainValuePicker(field: EditorFieldView): void {
        let options: ValuePickerOption[];
        let allowCustom = false;
        if (field.control._tag === "ChoiceControl") {
            options = field.control.choices.map((value) => ({
                label: primitiveChoiceLabel(value),
                value,
            }));
        } else if (
            field.control._tag === "TextControl" &&
            field.control.presentation === "combobox"
        ) {
            allowCustom = true;
            options = field.control.suggestions.map((value) => ({
                label: primitiveChoiceLabel(value),
                value,
            }));
            if (
                typeof field.value === "string" &&
                !options.some((option) => option.value === field.value)
            ) {
                options.unshift({ label: primitiveChoiceLabel(field.value), value: field.value });
            }
        } else {
            return;
        }
        const selectedIndex = Math.max(
            0,
            options.findIndex((option) => Object.is(option.value, field.value)),
        );
        this.valuePicker = {
            allowCustom,
            initialValue: field.value,
            options,
            target: { _tag: "MainFieldTarget", fieldIndex: this.selectedField },
            title: field.label,
            query: "",
            selectedIndex,
            scrollOffset: 0,
            error: undefined,
        };
        this.statusMessage = undefined;
        this.options.tui.requestRender();
    }

    private openStructuredValuePicker(
        row: Extract<StructuredEditorRow, { readonly _tag: "ValueRow" }>,
    ): void {
        const state = this.structuredEditing;
        if (state === undefined) return;
        let options: ValuePickerOption[];
        let allowCustom = false;
        if (row.node.control._tag === "ChoiceControl") {
            options = row.node.control.choices.map((value) => ({
                label: primitiveChoiceLabel(value),
                value,
            }));
        } else if (
            row.node.control._tag === "TextControl" &&
            row.node.control.presentation === "combobox"
        ) {
            allowCustom = true;
            options = row.node.control.suggestions.map((value) => ({
                label: primitiveChoiceLabel(value),
                value,
            }));
            if (
                typeof row.value === "string" &&
                !options.some((option) => option.value === row.value)
            ) {
                options.unshift({ label: primitiveChoiceLabel(row.value), value: row.value });
            }
        } else {
            return;
        }
        const selectedIndex = Math.max(
            0,
            options.findIndex((option) => Object.is(option.value, row.value)),
        );
        this.valuePicker = {
            allowCustom,
            initialValue: row.value,
            options,
            target: {
                _tag: "StructuredValueTarget",
                fieldIndex: state.fieldIndex,
                node: row.node,
                path: row.path,
            },
            title: row.node.label,
            query: "",
            selectedIndex,
            scrollOffset: 0,
            error: undefined,
        };
        this.statusMessage = undefined;
        this.options.tui.requestRender();
    }

    private handleValuePickerInput(data: string): void {
        const picker = this.valuePicker;
        if (picker === undefined) return;
        if (this.options.keybindings.matches(data, "tui.select.cancel")) {
            this.valuePicker = undefined;
            this.options.tui.requestRender();
            return;
        }
        const choices = this.filteredValuePickerOptions(picker);
        if (this.options.keybindings.matches(data, "tui.select.up")) {
            if (choices.length > 0) {
                picker.selectedIndex = (picker.selectedIndex - 1 + choices.length) % choices.length;
            }
        } else if (this.options.keybindings.matches(data, "tui.select.down")) {
            if (choices.length > 0) {
                picker.selectedIndex = (picker.selectedIndex + 1) % choices.length;
            }
        } else if (this.options.keybindings.matches(data, "tui.select.pageUp")) {
            picker.selectedIndex = Math.max(0, picker.selectedIndex - 10);
        } else if (this.options.keybindings.matches(data, "tui.select.pageDown")) {
            picker.selectedIndex = Math.min(
                Math.max(0, choices.length - 1),
                picker.selectedIndex + 10,
            );
        } else if (this.options.keybindings.matches(data, "tui.select.confirm")) {
            const choice = choices[picker.selectedIndex];
            if (choice !== undefined) this.commitValuePicker(choice.value);
            return;
        } else if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
            picker.query = Array.from(picker.query).slice(0, -1).join("");
            picker.selectedIndex = 0;
            picker.scrollOffset = 0;
            picker.error = undefined;
        } else if (isPrintableText(data)) {
            picker.query += data;
            picker.selectedIndex = 0;
            picker.scrollOffset = 0;
            picker.error = undefined;
        }
        this.options.tui.requestRender();
    }

    private commitValuePicker(value: JsonPrimitive): void {
        const picker = this.valuePicker;
        if (picker === undefined) return;
        if (Object.is(picker.initialValue, value)) {
            this.valuePicker = undefined;
            this.statusMessage = "No change.";
            this.options.tui.requestRender();
            return;
        }
        if (picker.target._tag === "MainFieldTarget") {
            const field = this.options.model.fields()[picker.target.fieldIndex];
            if (field === undefined) {
                picker.error = "The selected setting no longer exists.";
                this.options.tui.requestRender();
                return;
            }
            if (field.control._tag === "ChoiceControl") {
                const outcome = this.options.model.selectChoice(picker.target.fieldIndex, value);
                if (outcome._tag === "EditRejected") {
                    picker.error = outcome.message;
                    this.options.tui.requestRender();
                    return;
                }
            } else if (field.control._tag === "TextControl" && typeof value === "string") {
                const outcome = this.options.model.submitFieldText(picker.target.fieldIndex, value);
                if (outcome._tag === "SubmissionRejected") {
                    picker.error = outcome.message;
                    this.options.tui.requestRender();
                    return;
                }
            } else {
                picker.error = "This setting cannot use the selected value.";
                this.options.tui.requestRender();
                return;
            }
            this.valuePicker = undefined;
            this.statusMessage = "Setting updated.";
            this.startSave();
            return;
        }

        const field = this.options.model.fields()[picker.target.fieldIndex];
        if (field === undefined) {
            picker.error = "The selected setting no longer exists.";
            this.options.tui.requestRender();
            return;
        }
        let parsedValue: JsonValue = value;
        if (picker.target.node.control._tag === "TextControl") {
            if (typeof value !== "string") {
                picker.error = "Enter a text value.";
                this.options.tui.requestRender();
                return;
            }
            const parsed = parseStructuredInput(picker.target.node, value);
            if (parsed._tag === "StructuredInputRejected") {
                picker.error = parsed.message;
                this.options.tui.requestRender();
                return;
            }
            parsedValue = parsed.value;
        }
        const candidate = setStructuredValueAtPath(field.value, picker.target.path, parsedValue);
        const outcome = this.options.model.setFieldValue(picker.target.fieldIndex, candidate);
        if (outcome._tag === "EditRejected") {
            picker.error = outcome.message;
            this.options.tui.requestRender();
            return;
        }
        this.valuePicker = undefined;
        this.statusMessage = "Setting updated.";
        this.startSave();
    }

    private adjustMainSlider(direction: -1 | 1): void {
        const field = this.options.model.fields()[this.selectedField];
        if (field?.control._tag !== "NumberControl") return;
        const current = typeof field.value === "number" ? field.value : undefined;
        const next = stepSettingsNumber(field.control, current, direction);
        if (current !== undefined && Object.is(current, next)) {
            this.statusMessage =
                direction < 0 ? "Already at the minimum." : "Already at the maximum.";
            this.options.tui.requestRender();
            return;
        }
        this.applyEdit(this.options.model.setFieldValue(this.selectedField, next));
    }

    private completePathInput(input: Input): void {
        const outcome = completeSettingsPath(input.getValue(), this.options.cwd);
        if (outcome._tag === "PathUnavailable") {
            this.statusMessage = outcome.message;
        } else if (outcome._tag === "PathCompleted") {
            input.setValue(outcome.value);
            this.statusMessage = "Path completed.";
        } else {
            input.setValue(outcome.value);
            const visibleMatches = outcome.matches.slice(0, 5).join(", ");
            const remaining = Math.max(0, outcome.matches.length - 5);
            this.statusMessage = `${outcome.matches.length} matches: ${visibleMatches}${remaining === 0 ? "" : `, and ${remaining} more`}`;
        }
        this.options.tui.requestRender();
    }

    requestClose(): void {
        if (this.options.model.hasDirtySettings() && !this.discardArmed) {
            this.discardArmed = true;
            this.statusMessage = "Unsaved extension changes. Press Escape again to discard them.";
            this.options.tui.requestRender();
            return;
        }
        this.options.piSettings.leave();
        this.options.close();
    }

    private changeScope(scope: "global" | "project"): void {
        if (this.activeTabIndex === 0) {
            if (!this.options.piSettings.selectScope(scope)) {
                this.statusMessage = this.options.piSettings.scopeMessage(scope);
            } else {
                this.activeScopeValue = scope;
                this.statusMessage = undefined;
            }
        } else if (!this.options.model.selectScope(scope)) {
            this.statusMessage = this.options.model.scopeView(scope).message;
        } else {
            this.activeScopeValue = scope;
            this.statusMessage = undefined;
        }
        this.selectedField = 0;
        this.scrollOffset = 0;
        this.options.tui.requestRender();
    }

    private toggleScope(): void {
        this.changeScope(this.activeScopeValue === "global" ? "project" : "global");
    }

    private applyEdit(
        outcome:
            | { readonly _tag: "EditApplied" }
            | { readonly _tag: "EditRejected"; readonly message: string },
        successMessage = "Setting updated.",
    ): void {
        this.statusMessage = outcome._tag === "EditApplied" ? successMessage : outcome.message;
        this.options.tui.requestRender();
        if (outcome._tag === "EditApplied") this.startSave();
    }

    private beginEdit(): void {
        const field = this.options.model.fields()[this.selectedField];
        if (field === undefined) return;
        if (
            field.control._tag === "NumberControl" ||
            (field.control._tag === "TextControl" &&
                field.control.editor === "inline" &&
                !(typeof field.value === "string" && field.value.includes("\n")))
        ) {
            this.beginInlineEdit();
            return;
        }
        const editor = new Editor(this.options.tui, {
            borderColor: (text) => this.options.theme.fg("accent", text),
            selectList: getSelectListTheme(),
        });
        editor.setText(this.options.model.initialFieldText(this.selectedField));
        editor.focused = this._focused;
        editor.onSubmit = (text) => {
            const result = this.options.model.submitFieldText(this.selectedField, text);
            if (result._tag === "SubmissionRejected") {
                const editing = this.editing;
                if (editing !== undefined) editing.error = result.message;
            } else {
                this.editing = undefined;
                this.statusMessage = "Setting updated.";
                this.startSave();
            }
            this.options.tui.requestRender();
        };
        this.editing = { fieldIndex: this.selectedField, editor, error: undefined };
        this.statusMessage = undefined;
        this.options.tui.requestRender();
    }

    private beginInlineEdit(): void {
        const fieldIndex = this.selectedField;
        const input = new Input();
        input.setValue(this.options.model.initialFieldText(fieldIndex));
        input.focused = this._focused;
        input.onSubmit = (text) => {
            const result = this.options.model.submitFieldText(fieldIndex, text);
            if (result._tag === "SubmissionRejected") {
                const editing = this.inlineEditing;
                if (editing !== undefined) editing.error = result.message;
            } else {
                this.inlineEditing = undefined;
                this.statusMessage = "Setting updated.";
                this.startSave();
            }
            this.options.tui.requestRender();
        };
        this.inlineEditing = { fieldIndex, input, error: undefined };
        this.statusMessage = undefined;
        this.options.tui.requestRender();
    }

    private beginStructuredEdit(): void {
        const field = this.options.model.fields()[this.selectedField];
        if (field === undefined) return;
        this.structuredEditing = {
            fieldIndex: this.selectedField,
            selectedRow: 0,
            scrollOffset: 0,
            textEditing: undefined,
        };
        this.statusMessage = undefined;
        this.options.tui.requestRender();
    }

    private startSave(): void {
        const requests = this.options.model.saveRequests();
        if (requests.length === 0) {
            this.statusMessage = "No changes to save.";
            this.options.tui.requestRender();
            return;
        }
        this.saving = true;
        this.statusMessage = `Saving ${requests.length} settings file${requests.length === 1 ? "" : "s"}…`;
        this.options.tui.requestRender();
        void this.finishSave(requests);
    }

    private async finishSave(requests: readonly SaveSettingsLayerRequest[]): Promise<void> {
        let outcomes: readonly SaveSettingsLayerOutcome[];
        try {
            outcomes = await this.options.save(requests);
        } catch {
            this.saving = false;
            this.statusMessage = "Settings could not be saved.";
            this.options.tui.requestRender();
            return;
        }
        this.options.model.acceptSaveOutcomes(outcomes);
        const failures = outcomes.filter((outcome) => outcome._tag !== "SavedLayer");
        if (failures.length === 0) {
            const changed = outcomes.filter(
                (outcome) => outcome._tag === "SavedLayer" && outcome.changed,
            ).length;
            this.statusMessage =
                changed === 0
                    ? "Settings were already up to date."
                    : `Saved. Run /reload to apply the change.`;
        } else {
            this.statusMessage = failures[0]?.message ?? "Some settings could not be saved.";
        }
        this.saving = false;
        this.options.tui.requestRender();
    }
}
