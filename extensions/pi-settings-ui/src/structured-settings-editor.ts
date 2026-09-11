import {
    isJsonArray,
    isJsonBoolean,
    isJsonNumber,
    isJsonObject,
    isJsonString,
    type JsonObject,
    type JsonValue,
} from "./json-value.ts";
import {
    formatSettingLabel,
    materializeSettingsValue,
    parseSettingsValue,
    type SettingsValueNode,
} from "./settings-schema.ts";

export type StructuredValuePath = readonly (number | string)[];

type RemoveTarget = {
    readonly containerPath: StructuredValuePath;
    readonly key: number | string;
    readonly minimumItems: number;
};

export type StructuredEditorRow =
    | {
          readonly _tag: "AddRow";
          readonly containerPath: StructuredValuePath;
          readonly depth: number;
          readonly label: string;
          readonly node: SettingsValueNode;
      }
    | {
          readonly _tag: "GroupRow";
          readonly depth: number;
          readonly label: string;
          readonly path: StructuredValuePath;
          readonly remove: RemoveTarget | undefined;
          readonly renameable: boolean;
          readonly value: JsonValue | undefined;
      }
    | {
          readonly _tag: "ValueRow";
          readonly depth: number;
          readonly label: string;
          readonly node: SettingsValueNode;
          readonly path: StructuredValuePath;
          readonly remove: RemoveTarget | undefined;
          readonly value: JsonValue | undefined;
      }
    | {
          readonly _tag: "VariantRow";
          readonly depth: number;
          readonly label: string;
          readonly node: SettingsValueNode;
          readonly path: StructuredValuePath;
          readonly value: JsonValue | undefined;
          readonly variantIndex: number;
      };

export type StructuredValueOutcome =
    | { readonly _tag: "StructuredValueChanged"; readonly value: JsonValue }
    | { readonly _tag: "StructuredValueRejected"; readonly message: string };

export type ParseStructuredInputOutcome =
    | { readonly _tag: "StructuredInputParsed"; readonly value: JsonValue }
    | { readonly _tag: "StructuredInputRejected"; readonly message: string };

function isPathIndex(segment: number | string): segment is number {
    return typeof segment === "number";
}

function primitiveSummary(value: JsonValue | undefined): string | undefined {
    if (value === undefined) return "<unset>";
    if (value === null) return "<none>";
    if (isJsonString(value)) return value === "" ? '""' : value.replaceAll(/\s*\n\s*/g, " ");
    if (isJsonBoolean(value) || isJsonNumber(value)) return String(value);
    return undefined;
}

export function structuredValueSummary(value: JsonValue | undefined): string {
    const primitive = primitiveSummary(value);
    if (primitive !== undefined) return primitive;

    const count = isJsonArray(value)
        ? value.length
        : isJsonObject(value)
          ? Object.keys(value).length
          : 0;
    return `${count} ${count === 1 ? "entry" : "entries"}`;
}

function recordLabel(value: JsonValue | undefined, index: number): string {
    if (!isJsonObject(value)) return `Entry ${index + 1}`;

    const id = primitiveSummary(value.id);
    if (id !== undefined && value.id !== undefined) return id;

    const providerValue = value.provider;
    const modelValue = value.model ?? value.modelId;
    const provider = primitiveSummary(providerValue);
    const model = primitiveSummary(modelValue);

    if (
        providerValue !== undefined &&
        modelValue !== undefined &&
        provider !== undefined &&
        model !== undefined
    ) {
        return `${provider}/${model}`;
    }

    const target = value.target;
    if (isJsonObject(target)) {
        const kindValue = target.kind;
        const nameValue = target.name;
        const kind = primitiveSummary(kindValue);
        const name = primitiveSummary(nameValue);

        if (
            kindValue !== undefined &&
            nameValue !== undefined &&
            kind !== undefined &&
            name !== undefined
        ) {
            return `${kind}/${name}`;
        }
    }

    for (const key of ["key", "provider", "name", "label", "title", "alias"]) {
        const child = value[key];
        const label = primitiveSummary(child);
        if (child !== undefined && label !== undefined) return label;
    }

    return `Entry ${index + 1}`;
}

function valueMatchesNode(node: SettingsValueNode, value: JsonValue | undefined): boolean {
    if (value === undefined) return false;

    switch (node.control._tag) {
        case "BooleanControl":
            return isJsonBoolean(value);
        case "ChoiceControl":
            return node.control.choices.some((choice) => Object.is(choice, value));
        case "JsonControl":
            return true;
        case "ListControl":
            return isJsonArray(value);
        case "MapControl":
            return isJsonObject(value);
        case "NullControl":
            return value === null;
        case "NumberControl":
            return (
                isJsonNumber(value) &&
                Number.isFinite(value) &&
                (!node.control.integer || Number.isInteger(value))
            );
        case "ObjectControl":
            return (
                isJsonObject(value) &&
                node.control.properties.every(
                    (property) =>
                        (!property.node.required && value[property.key] === undefined) ||
                        valueMatchesNode(property.node, value[property.key]),
                )
            );
        case "ReadOnlyControl":
            return node.control.fixedValue === undefined
                ? true
                : Object.is(node.control.fixedValue, value);
        case "TextControl":
            return isJsonString(value);
        case "UnionControl":
            return node.control.variants.some((variant) => valueMatchesNode(variant.node, value));
    }
}

function activeVariantIndex(node: SettingsValueNode, value: JsonValue | undefined): number {
    if (node.control._tag !== "UnionControl") return 0;

    const index = node.control.variants.findIndex((variant) =>
        valueMatchesNode(variant.node, value),
    );
    return index === -1 ? 0 : index;
}

function appendNodeContent(
    rows: StructuredEditorRow[],
    node: SettingsValueNode,
    value: JsonValue | undefined,
    path: StructuredValuePath,
    depth: number,
): void {
    switch (node.control._tag) {
        case "ListControl": {
            const values = isJsonArray(value) ? value : [];
            for (const [index, item] of values.entries()) {
                const remove: RemoveTarget = {
                    containerPath: path,
                    key: index,
                    minimumItems: node.control.minItems,
                };
                const itemPath = [...path, index];
                const itemControl = node.control.item.control;
                if (
                    itemControl._tag === "BooleanControl" ||
                    itemControl._tag === "ChoiceControl" ||
                    itemControl._tag === "JsonControl" ||
                    itemControl._tag === "NullControl" ||
                    itemControl._tag === "NumberControl" ||
                    itemControl._tag === "ReadOnlyControl" ||
                    itemControl._tag === "TextControl"
                ) {
                    rows.push({
                        _tag: "ValueRow",
                        depth,
                        label: `Entry ${index + 1}`,
                        node: node.control.item,
                        path: itemPath,
                        remove,
                        value: item,
                    });

                    continue;
                }

                rows.push({
                    _tag: "GroupRow",
                    depth,
                    label: recordLabel(item, index),
                    path: itemPath,
                    remove,
                    renameable: false,
                    value: item,
                });
                appendNodeContent(rows, node.control.item, item, itemPath, depth + 1);
            }

            rows.push({
                _tag: "AddRow",
                containerPath: path,
                depth,
                label: "Add entry",
                node,
            });

            return;
        }
        case "MapControl": {
            const entries = isJsonObject(value) ? Object.entries(value) : [];
            for (const [key, child] of entries) {
                const childPath = [...path, key];

                rows.push({
                    _tag: "GroupRow",
                    depth,
                    label: key,
                    path: childPath,
                    remove: { containerPath: path, key, minimumItems: 0 },
                    renameable: true,
                    value: child,
                });

                const childControl = node.control.value.control;
                if (
                    childControl._tag === "BooleanControl" ||
                    childControl._tag === "ChoiceControl" ||
                    childControl._tag === "JsonControl" ||
                    childControl._tag === "NullControl" ||
                    childControl._tag === "NumberControl" ||
                    childControl._tag === "ReadOnlyControl" ||
                    childControl._tag === "TextControl"
                ) {
                    rows.push({
                        _tag: "ValueRow",
                        depth: depth + 1,
                        label: node.control.value.label,
                        node: node.control.value,
                        path: childPath,
                        remove: undefined,
                        value: child,
                    });
                } else {
                    appendNodeContent(rows, node.control.value, child, childPath, depth + 1);
                }
            }

            rows.push({
                _tag: "AddRow",
                containerPath: path,
                depth,
                label: "Add entry",
                node,
            });

            return;
        }
        case "ObjectControl": {
            const object = isJsonObject(value) ? value : {};
            for (const property of node.control.properties) {
                const child = object[property.key];
                const childPath = [...path, property.key];
                const childControl = property.node.control;
                if (
                    childControl._tag === "BooleanControl" ||
                    childControl._tag === "ChoiceControl" ||
                    childControl._tag === "JsonControl" ||
                    childControl._tag === "NullControl" ||
                    childControl._tag === "NumberControl" ||
                    childControl._tag === "ReadOnlyControl" ||
                    childControl._tag === "TextControl"
                ) {
                    rows.push({
                        _tag: "ValueRow",
                        depth,
                        label: property.node.label,
                        node: property.node,
                        path: childPath,
                        remove: undefined,
                        value: child,
                    });

                    continue;
                }

                rows.push({
                    _tag: "GroupRow",
                    depth,
                    label: property.node.label,
                    path: childPath,
                    remove: undefined,
                    renameable: false,
                    value: child,
                });
                appendNodeContent(rows, property.node, child, childPath, depth + 1);
            }

            return;
        }
        case "UnionControl": {
            const variantIndex = activeVariantIndex(node, value);
            const variant = node.control.variants[variantIndex];
            rows.push({
                _tag: "VariantRow",
                depth,
                label: "Type",
                node,
                path,
                value,
                variantIndex,
            });

            if (variant === undefined) return;

            const variantControl = variant.node.control;
            if (
                variantControl._tag === "BooleanControl" ||
                variantControl._tag === "ChoiceControl" ||
                variantControl._tag === "JsonControl" ||
                variantControl._tag === "NullControl" ||
                variantControl._tag === "NumberControl" ||
                variantControl._tag === "ReadOnlyControl" ||
                variantControl._tag === "TextControl"
            ) {
                rows.push({
                    _tag: "ValueRow",
                    depth: depth + 1,
                    label: "Value",
                    node: variant.node,
                    path,
                    remove: undefined,
                    value,
                });
            } else {
                appendNodeContent(rows, variant.node, value, path, depth + 1);
            }

            return;
        }
        case "BooleanControl":
        case "ChoiceControl":
        case "JsonControl":
        case "NullControl":
        case "NumberControl":
        case "ReadOnlyControl":
        case "TextControl":
            rows.push({
                _tag: "ValueRow",
                depth,
                label: node.label,
                node,
                path,
                remove: undefined,
                value,
            });
    }
}

/** Lower one structured field value into navigable TUI rows. */
export function buildStructuredRows(
    node: SettingsValueNode,
    value: JsonValue | undefined,
): readonly StructuredEditorRow[] {
    const rows: StructuredEditorRow[] = [];
    appendNodeContent(rows, node, value, [], 1);
    return rows;
}

export function structuredValueAtPath(
    value: JsonValue | undefined,
    path: StructuredValuePath,
): JsonValue | undefined {
    let current = value;

    for (const segment of path) {
        if (isPathIndex(segment)) {
            if (!isJsonArray(current)) return undefined;

            current = current[segment];
            continue;
        }

        if (!isJsonObject(current)) return undefined;

        current = current[segment];
    }

    return current;
}

export function setStructuredValueAtPath(
    value: JsonValue | undefined,
    path: StructuredValuePath,
    child: JsonValue,
): JsonValue {
    const [segment, ...remaining] = path;

    if (segment === undefined) return structuredClone(child);

    if (isPathIndex(segment)) {
        const values: JsonValue[] = isJsonArray(value) ? [...value] : [];
        values[segment] = setStructuredValueAtPath(values[segment], remaining, child);
        return values;
    }

    const object: Record<string, JsonValue> = isJsonObject(value) ? { ...value } : {};
    object[segment] = setStructuredValueAtPath(object[segment], remaining, child);
    return object;
}

function withContainerValue(
    root: JsonValue | undefined,
    path: StructuredValuePath,
    update: (value: JsonValue | undefined) => StructuredValueOutcome,
): StructuredValueOutcome {
    const current = structuredValueAtPath(root, path);
    const result = update(current);
    if (result._tag === "StructuredValueRejected") return result;

    return {
        _tag: "StructuredValueChanged",
        value: setStructuredValueAtPath(root, path, result.value),
    };
}

function nextMapKey(value: JsonObject, pattern: string | undefined): string | undefined {
    let expression: RegExp | undefined;
    if (pattern !== undefined) {
        try {
            expression = new RegExp(pattern, "u");
        } catch {
            return undefined;
        }
    }

    for (let index = 1; index <= 10_000; index += 1) {
        const key = `entry_${index}`;
        if (!(key in value) && (expression === undefined || expression.test(key))) return key;
    }

    return undefined;
}

export function addStructuredEntry(
    root: JsonValue | undefined,
    row: Extract<StructuredEditorRow, { readonly _tag: "AddRow" }>,
): StructuredValueOutcome {
    return withContainerValue(root, row.containerPath, (current) => {
        switch (row.node.control._tag) {
            case "ListControl": {
                const values = isJsonArray(current) ? [...current] : [];
                if (
                    row.node.control.maxItems !== undefined &&
                    values.length >= row.node.control.maxItems
                ) {
                    return {
                        _tag: "StructuredValueRejected",
                        message: `This list allows at most ${row.node.control.maxItems} entries.`,
                    };
                }

                const item = materializeSettingsValue(row.node.control.item);
                if (item === undefined) {
                    return {
                        _tag: "StructuredValueRejected",
                        message:
                            "This schema cannot create a safe entry automatically; use the JSON fallback for this nested value.",
                    };
                }

                values.push(item);

                return { _tag: "StructuredValueChanged", value: values };
            }
            case "MapControl": {
                const object = isJsonObject(current) ? current : {};
                const key = nextMapKey(object, row.node.control.keyPattern);
                const child = materializeSettingsValue(row.node.control.value);
                if (key === undefined || child === undefined) {
                    return {
                        _tag: "StructuredValueRejected",
                        message: "This schema cannot create a safe map entry automatically.",
                    };
                }

                return {
                    _tag: "StructuredValueChanged",
                    value: { ...object, [key]: child },
                };
            }
            case "BooleanControl":
            case "ChoiceControl":
            case "JsonControl":
            case "NullControl":
            case "NumberControl":
            case "ObjectControl":
            case "ReadOnlyControl":
            case "TextControl":
            case "UnionControl":
                return {
                    _tag: "StructuredValueRejected",
                    message: "The selected row is not a collection.",
                };
        }
    });
}

export function removeStructuredEntry(
    root: JsonValue | undefined,
    row: Extract<StructuredEditorRow, { readonly _tag: "GroupRow" | "ValueRow" }>,
): StructuredValueOutcome {
    const remove = row.remove;
    if (remove === undefined) {
        return { _tag: "StructuredValueRejected", message: "The selected row is not removable." };
    }

    return withContainerValue(root, remove.containerPath, (current) => {
        if (isPathIndex(remove.key)) {
            if (!isJsonArray(current)) {
                return { _tag: "StructuredValueRejected", message: "The list no longer exists." };
            }

            if (current.length <= remove.minimumItems) {
                return {
                    _tag: "StructuredValueRejected",
                    message: `This list requires at least ${remove.minimumItems} entries.`,
                };
            }

            return {
                _tag: "StructuredValueChanged",
                value: current.filter((_, index) => index !== remove.key),
            };
        }

        if (!isJsonObject(current) || !(remove.key in current)) {
            return { _tag: "StructuredValueRejected", message: "The map entry no longer exists." };
        }

        const next = { ...current };
        delete next[remove.key];

        return { _tag: "StructuredValueChanged", value: next };
    });
}

export function renameStructuredMapEntry(
    root: JsonValue | undefined,
    row: Extract<StructuredEditorRow, { readonly _tag: "GroupRow" }>,
    nextKeyInput: string,
): StructuredValueOutcome {
    const remove = row.remove;
    if (!row.renameable || remove === undefined || isPathIndex(remove.key)) {
        return { _tag: "StructuredValueRejected", message: "The selected row is not renameable." };
    }

    const nextKey = nextKeyInput.trim();
    if (nextKey === "") {
        return { _tag: "StructuredValueRejected", message: "Enter a non-empty map key." };
    }

    return withContainerValue(root, remove.containerPath, (current) => {
        if (!isJsonObject(current) || !(remove.key in current)) {
            return { _tag: "StructuredValueRejected", message: "The map entry no longer exists." };
        }

        if (nextKey !== remove.key && nextKey in current) {
            return { _tag: "StructuredValueRejected", message: "That map key already exists." };
        }

        const next: Record<string, JsonValue> = {};
        for (const [key, value] of Object.entries(current)) {
            next[key === remove.key ? nextKey : key] = value;
        }

        return { _tag: "StructuredValueChanged", value: next };
    });
}

export function cycleStructuredVariant(
    root: JsonValue | undefined,
    row: Extract<StructuredEditorRow, { readonly _tag: "VariantRow" }>,
    offset: number,
): StructuredValueOutcome {
    if (row.node.control._tag !== "UnionControl" || row.node.control.variants.length === 0) {
        return { _tag: "StructuredValueRejected", message: "This setting has no variants." };
    }

    const index =
        (row.variantIndex + offset + row.node.control.variants.length) %
        row.node.control.variants.length;
    const variant = row.node.control.variants[index];
    const value = variant === undefined ? undefined : materializeSettingsValue(variant.node);
    if (value === undefined) {
        return {
            _tag: "StructuredValueRejected",
            message: "This schema variant cannot be initialized safely.",
        };
    }

    return {
        _tag: "StructuredValueChanged",
        value: setStructuredValueAtPath(root, row.path, value),
    };
}

export function parseStructuredInput(
    node: SettingsValueNode,
    text: string,
): ParseStructuredInputOutcome {
    switch (node.control._tag) {
        case "TextControl":
            return { _tag: "StructuredInputParsed", value: text };
        case "NumberControl": {
            if (text.trim() === "") {
                return { _tag: "StructuredInputRejected", message: "Enter a finite number." };
            }

            const value = Number(text);
            if (!Number.isFinite(value)) {
                return { _tag: "StructuredInputRejected", message: "Enter a finite number." };
            }

            if (node.control.integer && !Number.isInteger(value)) {
                return { _tag: "StructuredInputRejected", message: "Enter a whole number." };
            }

            return { _tag: "StructuredInputParsed", value };
        }
        case "JsonControl": {
            const parsed = parseSettingsValue(text);
            return parsed._tag === "ParsedValue"
                ? { _tag: "StructuredInputParsed", value: parsed.value }
                : { _tag: "StructuredInputRejected", message: parsed.message };
        }
        case "BooleanControl":
        case "ChoiceControl":
        case "ListControl":
        case "MapControl":
        case "NullControl":
        case "ObjectControl":
        case "ReadOnlyControl":
        case "UnionControl":
            return {
                _tag: "StructuredInputRejected",
                message: "This value is edited with a structured control.",
            };
    }
}

export function initialStructuredInput(row: StructuredEditorRow): string {
    if (row._tag === "GroupRow") return row.label;
    if (row._tag !== "ValueRow" || row.value === undefined) return "";

    switch (row.node.control._tag) {
        case "TextControl":
            return isJsonString(row.value) ? row.value : "";
        case "NumberControl":
            return isJsonNumber(row.value) ? String(row.value) : "";
        case "JsonControl":
            return JSON.stringify(row.value, null, 2);
        case "BooleanControl":
        case "ChoiceControl":
        case "ListControl":
        case "MapControl":
        case "NullControl":
        case "ObjectControl":
        case "ReadOnlyControl":
        case "UnionControl":
            return "";
    }
}

export function structuredRowLabel(row: StructuredEditorRow): string {
    if (row._tag === "AddRow") return `+ ${row.label}`;
    return row.label;
}

export function structuredRowValue(row: StructuredEditorRow): string {
    if (row._tag === "AddRow") return "";

    if (row._tag === "VariantRow" && row.node.control._tag === "UnionControl") {
        return row.node.control.variants[row.variantIndex]?.label ?? "Unknown";
    }

    if (row._tag === "GroupRow") {
        if (row.renameable) return "";
        return structuredValueSummary(row.value);
    }

    if (row.node.control._tag === "ChoiceControl") {
        const value = primitiveSummary(row.value);
        return value === undefined ? "<unset>" : formatSettingLabel(value);
    }

    if (row.node.control._tag === "ReadOnlyControl" && isJsonString(row.node.control.fixedValue)) {
        return formatSettingLabel(row.node.control.fixedValue);
    }

    return structuredValueSummary(row.value);
}
