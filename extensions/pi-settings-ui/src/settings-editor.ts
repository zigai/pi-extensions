import {
    isJsonArray,
    isJsonNumber,
    isJsonObject,
    isJsonString,
    type JsonObject,
    type JsonPrimitive,
    type JsonValue,
} from "./json-value.ts";
import {
    type ExtensionSettingsSchema,
    type SettingsControl,
    type SettingsField,
    parseSettingsDocument,
    parseSettingsValue,
} from "./settings-schema.ts";
import {
    type CatalogExtensionSettings,
    type SaveSettingsLayerOutcome,
    type SaveSettingsLayerRequest,
    type SettingsCatalog,
    type SettingsLayerSnapshot,
    type SettingsScope,
} from "./settings-store.ts";

type ReadyDraft = {
    readonly _tag: "ReadyDraft";
    readonly path: string;
    originalText: string | undefined;
    baseline: JsonObject;
    document: JsonObject;
};

type LayerDraft =
    | {
          readonly _tag: "BlockedDraft";
          readonly path: string;
          readonly message: string;
          readonly issues: readonly string[];
      }
    | ReadyDraft
    | {
          readonly _tag: "UnavailableDraft";
          readonly path: string;
          readonly message: string;
      };

type ExtensionDraft = {
    readonly schema: ExtensionSettingsSchema;
    readonly global: LayerDraft;
    readonly project: LayerDraft;
};

export type EditorTabView = {
    readonly id: string;
    readonly title: string;
    readonly dirty: boolean;
    readonly blocked: boolean;
};

export type EditorScopeView = {
    readonly scope: SettingsScope;
    readonly available: boolean;
    readonly editable: boolean;
    readonly dirty: boolean;
    readonly overrideCount: number;
    readonly message: string;
};

export type EditorFieldView = SettingsField & {
    readonly value: JsonValue | undefined;
    readonly overridden: boolean;
};

export type EditSettingsOutcome =
    | { readonly _tag: "EditApplied" }
    | { readonly _tag: "EditRejected"; readonly message: string };

export type SubmitFieldOutcome =
    | { readonly _tag: "FieldSubmitted" }
    | { readonly _tag: "SubmissionRejected"; readonly message: string };

function cloneJson<Value extends JsonValue>(value: Value): Value {
    return structuredClone(value);
}

function canonicalJson(value: JsonValue): JsonValue {
    if (isJsonArray(value)) return value.map(canonicalJson);
    if (!isJsonObject(value)) return value;

    const canonical: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
        const child = value[key];
        if (child !== undefined) canonical[key] = canonicalJson(child);
    }

    return canonical;
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
    return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function layerDraft(snapshot: SettingsLayerSnapshot): LayerDraft {
    switch (snapshot._tag) {
        case "BlockedLayer":
            return {
                _tag: "BlockedDraft",
                path: snapshot.path,
                message: snapshot.message,
                issues: snapshot.issues,
            };
        case "ReadyLayer":
            return {
                _tag: "ReadyDraft",
                path: snapshot.path,
                originalText: snapshot.sourceText,
                baseline: cloneJson(snapshot.document),
                document: cloneJson(snapshot.document),
            };
        case "UnavailableLayer":
            return {
                _tag: "UnavailableDraft",
                path: snapshot.path,
                message: snapshot.message,
            };
    }
}

function readyLayer(draft: ExtensionDraft, scope: SettingsScope): ReadyDraft | undefined {
    const layer = scope === "global" ? draft.global : draft.project;
    return layer._tag === "ReadyDraft" ? layer : undefined;
}

function isDirty(layer: LayerDraft): boolean {
    return layer._tag === "ReadyDraft" && !sameJson(layer.baseline, layer.document);
}

function mergeJsonObjects(base: JsonObject, override: JsonObject): JsonObject {
    const merged = { ...base };
    for (const [key, value] of Object.entries(override)) {
        const existing = merged[key];
        if (isJsonObject(existing) && isJsonObject(value)) {
            merged[key] = mergeJsonObjects(existing, value);
            continue;
        }

        merged[key] = cloneJson(value);
    }

    return merged;
}

function valueAtPath(document: JsonObject, path: readonly string[]): JsonValue | undefined {
    let current: JsonValue = document;

    for (const segment of path) {
        if (!isJsonObject(current)) return undefined;

        const next: JsonValue | undefined = current[segment];
        if (next === undefined) return undefined;

        current = next;
    }

    return current;
}

function hasPath(document: JsonObject, path: readonly string[]): boolean {
    if (path.length === 0) return true;

    let current: JsonValue = document;

    for (const segment of path) {
        if (!isJsonObject(current)) return false;
        if (!(segment in current)) return false;

        const next: JsonValue | undefined = current[segment];
        if (next === undefined) return false;

        current = next;
    }

    return true;
}

function setPath(document: JsonObject, path: readonly string[], value: JsonValue): JsonObject {
    const [segment, ...remaining] = path;

    if (segment === undefined) return document;
    if (remaining.length === 0) return { ...document, [segment]: cloneJson(value) };

    const existing = document[segment];
    const child: JsonObject = isJsonObject(existing) ? existing : {};
    return { ...document, [segment]: setPath(child, remaining, value) };
}

function removePath(document: JsonObject, path: readonly string[]): JsonObject {
    const [segment, ...remaining] = path;

    if (segment === undefined || !(segment in document)) return document;

    const next = { ...document };
    if (remaining.length === 0) {
        delete next[segment];
        return next;
    }

    const existing = document[segment];
    if (!isJsonObject(existing)) return document;

    const child = removePath(existing, remaining);
    if (Object.keys(child).length === 0) delete next[segment];
    else next[segment] = child;

    return next;
}

function countOverrides(document: JsonObject): number {
    return Object.keys(document).filter((key) => key !== "$schema").length;
}

function resolveDocument(draft: ExtensionDraft, scope: SettingsScope): JsonObject {
    const global = readyLayer(draft, "global")?.document ?? {};
    const project = readyLayer(draft, "project")?.document ?? {};
    const withGlobal = mergeJsonObjects(draft.schema.defaultDocument, global);
    return scope === "project" ? mergeJsonObjects(withGlobal, project) : withGlobal;
}

function controlValueLabel(control: SettingsControl): string {
    switch (control._tag) {
        case "BooleanControl":
            return "boolean";
        case "ChoiceControl":
            return "choice";
        case "JsonControl":
            return control.expected;
        case "ListControl":
            return control.expected;
        case "MapControl":
            return "structured map";
        case "NullControl":
            return "null";
        case "NumberControl":
            return control.integer ? "integer" : "number";
        case "ObjectControl":
            return "structured object";
        case "ReadOnlyControl":
            return "read-only";
        case "TextControl":
            return "text";
        case "UnionControl":
            return "structured choice";
    }
}

function parseNumberInput(text: string): number | undefined {
    if (text.trim() === "") return undefined;

    const value = Number(text);
    return Number.isFinite(value) ? value : undefined;
}

function serializeDocument(document: JsonObject): string {
    return `${JSON.stringify(document, null, 2)}\n`;
}

/** Owns drafts, inheritance, schema validation, and save-request creation for the TUI. */
export class SettingsEditorModel {
    private readonly extensions: ExtensionDraft[];
    private activeIndex = 0;
    private activeScopeValue: SettingsScope = "global";

    constructor(
        catalog: SettingsCatalog,
        private readonly projectScopeEnabled: boolean,
    ) {
        this.extensions = catalog.extensions.map((extension: CatalogExtensionSettings) => ({
            schema: extension.schema,
            global: layerDraft(extension.global),
            project: layerDraft(extension.project),
        }));
    }

    get extensionCount(): number {
        return this.extensions.length;
    }

    get activeScope(): SettingsScope {
        return this.activeScopeValue;
    }

    get activeExtensionId(): string | undefined {
        return this.activeExtension()?.schema.id;
    }

    tabs(): readonly EditorTabView[] {
        return this.extensions.map((extension) => ({
            id: extension.schema.id,
            title: extension.schema.title,
            dirty: isDirty(extension.global) || isDirty(extension.project),
            blocked:
                extension.global._tag === "BlockedDraft" ||
                extension.project._tag === "BlockedDraft",
        }));
    }

    selectExtension(index: number): void {
        if (index < 0 || index >= this.extensions.length) return;

        this.activeIndex = index;
        if (!this.scopeView(this.activeScopeValue).available) this.activeScopeValue = "global";
    }

    selectAdjacentExtension(offset: number): void {
        if (this.extensions.length === 0) return;

        this.activeIndex =
            (this.activeIndex + offset + this.extensions.length) % this.extensions.length;
        if (!this.scopeView(this.activeScopeValue).available) this.activeScopeValue = "global";
    }

    selectScope(scope: SettingsScope): boolean {
        if (!this.scopeView(scope).available) return false;

        this.activeScopeValue = scope;
        return true;
    }

    scopeView(scope: SettingsScope): EditorScopeView {
        const extension = this.activeExtension();
        if (extension === undefined) {
            return {
                scope,
                available: false,
                editable: false,
                dirty: false,
                overrideCount: 0,
                message: "No extension settings schemas were found.",
            };
        }

        const layer = scope === "global" ? extension.global : extension.project;

        if (scope === "project" && !this.projectScopeEnabled) {
            return {
                scope,
                available: false,
                editable: false,
                dirty: false,
                overrideCount: 0,
                message: "Project overrides are disabled in Pi Settings UI settings.",
            };
        }

        if (layer._tag === "UnavailableDraft") {
            return {
                scope,
                available: false,
                editable: false,
                dirty: false,
                overrideCount: 0,
                message: layer.message,
            };
        }

        if (layer._tag === "BlockedDraft") {
            const issue = layer.issues[0];
            const details = issue === undefined ? layer.message : `${layer.message} ${issue}`;
            return {
                scope,
                available: true,
                editable: false,
                dirty: false,
                overrideCount: 0,
                message: `${details} Fix ${layer.path} before editing it here.`,
            };
        }

        return {
            scope,
            available: true,
            editable: true,
            dirty: isDirty(layer),
            overrideCount: countOverrides(layer.document),
            message:
                layer.originalText === undefined ? `New settings file: ${layer.path}` : layer.path,
        };
    }

    fields(): readonly EditorFieldView[] {
        const extension = this.activeExtension();
        if (extension === undefined) return [];

        const layer = readyLayer(extension, this.activeScopeValue);
        const effective = resolveDocument(extension, this.activeScopeValue);

        return extension.schema.fields.map((field) => ({
            ...field,
            value: valueAtPath(effective, field.path),
            overridden: layer === undefined ? false : hasPath(layer.document, field.path),
        }));
    }

    setFieldValue(fieldIndex: number, value: JsonValue): EditSettingsOutcome {
        return this.setFieldAndSiblingValues(fieldIndex, value, {});
    }

    private setFieldAndSiblingValues(
        fieldIndex: number,
        value: JsonValue,
        siblingValues: JsonObject,
    ): EditSettingsOutcome {
        const extension = this.activeExtension();
        const field = extension?.schema.fields[fieldIndex];
        if (extension === undefined || field === undefined) {
            return { _tag: "EditRejected", message: "The selected setting no longer exists." };
        }

        if (field.control._tag === "ReadOnlyControl") {
            return { _tag: "EditRejected", message: field.control.reason };
        }

        const layer = readyLayer(extension, this.activeScopeValue);
        if (layer === undefined) {
            return { _tag: "EditRejected", message: this.scopeView(this.activeScopeValue).message };
        }

        let candidate = setPath(layer.document, field.path, value);
        const parentPath = field.path.slice(0, -1);
        for (const [key, siblingValue] of Object.entries(siblingValues)) {
            candidate = setPath(candidate, [...parentPath, key], siblingValue);
        }

        const parsed = parseSettingsDocument(extension.schema, serializeDocument(candidate));
        if (parsed._tag === "InvalidDocument") {
            return {
                _tag: "EditRejected",
                message: parsed.issues[0] ?? parsed.message,
            };
        }

        layer.document = parsed.document;
        return { _tag: "EditApplied" };
    }

    clearField(fieldIndex: number): EditSettingsOutcome {
        const extension = this.activeExtension();
        const field = extension?.schema.fields[fieldIndex];
        if (extension === undefined || field === undefined) {
            return { _tag: "EditRejected", message: "The selected setting no longer exists." };
        }

        if (field.control._tag === "ReadOnlyControl") {
            return { _tag: "EditRejected", message: field.control.reason };
        }

        const layer = readyLayer(extension, this.activeScopeValue);
        if (layer === undefined) {
            return { _tag: "EditRejected", message: this.scopeView(this.activeScopeValue).message };
        }

        const candidate = removePath(layer.document, field.path);
        const parsed = parseSettingsDocument(extension.schema, serializeDocument(candidate));
        if (parsed._tag === "InvalidDocument") {
            return {
                _tag: "EditRejected",
                message: parsed.issues[0] ?? parsed.message,
            };
        }

        layer.document = parsed.document;
        return { _tag: "EditApplied" };
    }

    toggleBoolean(fieldIndex: number): EditSettingsOutcome {
        const field = this.fields()[fieldIndex];
        if (field?.control._tag !== "BooleanControl") {
            return { _tag: "EditRejected", message: "The selected setting is not a boolean." };
        }

        return this.setFieldValue(fieldIndex, field.value !== true);
    }

    cycleChoice(fieldIndex: number, offset: number): EditSettingsOutcome {
        const field = this.fields()[fieldIndex];
        if (field?.control._tag !== "ChoiceControl") {
            return { _tag: "EditRejected", message: "The selected setting is not a choice." };
        }

        const currentIndex = field.control.choices.findIndex((choice: JsonPrimitive) =>
            Object.is(choice, field.value),
        );
        const index =
            currentIndex === -1
                ? offset < 0
                    ? field.control.choices.length - 1
                    : 0
                : (currentIndex + offset + field.control.choices.length) %
                  field.control.choices.length;
        const choice = field.control.choices[index];
        if (choice === undefined) {
            return { _tag: "EditRejected", message: "The setting has no available choices." };
        }

        return this.selectChoice(fieldIndex, choice);
    }

    selectChoice(fieldIndex: number, choice: JsonPrimitive): EditSettingsOutcome {
        const field = this.fields()[fieldIndex];
        if (field?.control._tag !== "ChoiceControl") {
            return { _tag: "EditRejected", message: "The selected setting is not a choice." };
        }

        if (!field.control.choices.some((candidate) => Object.is(candidate, choice))) {
            return { _tag: "EditRejected", message: "That choice is not accepted by the schema." };
        }

        const choiceDefaults = field.choiceDefaults.find((candidate) =>
            Object.is(candidate.choice, choice),
        );
        return this.setFieldAndSiblingValues(
            fieldIndex,
            choice,
            choiceDefaults?.siblingValues ?? {},
        );
    }

    submitFieldText(fieldIndex: number, text: string): SubmitFieldOutcome {
        const field = this.fields()[fieldIndex];
        if (field === undefined) {
            return {
                _tag: "SubmissionRejected",
                message: "The selected setting no longer exists.",
            };
        }

        let value: JsonValue;
        switch (field.control._tag) {
            case "TextControl":
                value = text;
                break;
            case "NumberControl": {
                const parsed = parseNumberInput(text);
                if (parsed === undefined) {
                    return { _tag: "SubmissionRejected", message: "Enter a finite number." };
                }

                value = parsed;
                break;
            }
            case "JsonControl":
            case "ListControl":
            case "MapControl":
            case "ObjectControl":
            case "UnionControl": {
                const parsed = parseSettingsValue(text);
                if (parsed._tag === "InvalidValue") {
                    return { _tag: "SubmissionRejected", message: parsed.message };
                }

                value = parsed.value;
                break;
            }
            case "BooleanControl":
            case "ChoiceControl":
            case "NullControl":
            case "ReadOnlyControl":
                return {
                    _tag: "SubmissionRejected",
                    message: `${controlValueLabel(field.control)} settings are not edited as text.`,
                };
        }

        const edited = this.setFieldValue(fieldIndex, value);
        return edited._tag === "EditApplied"
            ? { _tag: "FieldSubmitted" }
            : { _tag: "SubmissionRejected", message: edited.message };
    }

    initialFieldText(fieldIndex: number): string {
        const field = this.fields()[fieldIndex];
        if (field === undefined || field.value === undefined) return "";

        switch (field.control._tag) {
            case "TextControl":
                return isJsonString(field.value) ? field.value : "";
            case "NumberControl":
                return isJsonNumber(field.value) ? String(field.value) : "";
            case "JsonControl":
            case "ListControl":
            case "MapControl":
            case "ObjectControl":
            case "UnionControl":
                return JSON.stringify(field.value, null, 2);
            case "BooleanControl":
            case "ChoiceControl":
            case "NullControl":
            case "ReadOnlyControl":
                return "";
        }
    }

    hasDirtySettings(): boolean {
        return this.extensions.some(
            (extension) => isDirty(extension.global) || isDirty(extension.project),
        );
    }

    saveRequests(): readonly SaveSettingsLayerRequest[] {
        const requests: SaveSettingsLayerRequest[] = [];
        for (const extension of this.extensions) {
            for (const scope of ["global", "project"] as const) {
                const layer = readyLayer(extension, scope);
                if (layer === undefined || !isDirty(layer)) continue;
                requests.push({
                    extensionId: extension.schema.id,
                    scope,
                    schemaPath: extension.schema.schemaPath,
                    expectedSchemaText: extension.schema.schemaText,
                    configPath: layer.path,
                    expectedConfigText: layer.originalText,
                    content: serializeDocument(layer.document),
                });
            }
        }

        return requests;
    }

    acceptSaveOutcomes(outcomes: readonly SaveSettingsLayerOutcome[]): void {
        for (const outcome of outcomes) {
            if (outcome._tag !== "SavedLayer") continue;

            const extension = this.extensions.find(
                (candidate) => candidate.schema.id === outcome.extensionId,
            );
            if (extension === undefined) continue;

            const layer = readyLayer(extension, outcome.scope);
            if (layer === undefined) continue;
            layer.originalText = outcome.content;
            layer.baseline = cloneJson(layer.document);
        }
    }

    private activeExtension(): ExtensionDraft | undefined {
        return this.extensions[this.activeIndex];
    }
}
