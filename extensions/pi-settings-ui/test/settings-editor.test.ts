import { describe, expect, it } from "vitest";

import { SettingsEditorModel } from "../src/settings-editor.ts";
import type { CatalogExtensionSettings } from "../src/settings-store.ts";
import { editableCatalog, parseFixtureSchema } from "./fixture.ts";

function fixtureExtension(): CatalogExtensionSettings {
    const schema = parseFixtureSchema();
    return {
        schema,
        global: {
            _tag: "ReadyLayer",
            path: "/agent/extension-settings/pi-fixture.json",
            sourceText:
                '{"$schema":"./schemas/pi-fixture.schema.json","mode":"fast","nested":{"label":"global"}}\n',
            document: {
                $schema: "./schemas/pi-fixture.schema.json",
                mode: "fast",
                nested: { label: "global" },
            },
        },
        project: {
            _tag: "ReadyLayer",
            path: "/project/.pi/extension-settings/pi-fixture.json",
            sourceText: '{"nested":{"visible":false}}\n',
            document: { nested: { visible: false } },
        },
    };
}

function fieldIndex(model: SettingsEditorModel, path: string): number {
    return model.fields().findIndex((field) => field.path.join(".") === path);
}

describe("settings editor model", () => {
    it("edits typed controls and rejects values outside schema constraints", () => {
        const model = new SettingsEditorModel(editableCatalog([fixtureExtension()]), true);
        const enabled = fieldIndex(model, "enabled");
        const threshold = fieldIndex(model, "threshold");
        const names = fieldIndex(model, "names");

        expect(model.toggleBoolean(enabled)).toEqual({ _tag: "EditApplied" });
        expect(model.fields()[enabled]).toMatchObject({ value: false, overridden: true });
        const invalidThreshold = model.submitFieldText(threshold, "0");
        expect(invalidThreshold._tag).toBe("SubmissionRejected");
        if (invalidThreshold._tag === "SubmissionRejected") {
            expect(invalidThreshold.message).toContain("/threshold");
        }
        expect(model.submitFieldText(threshold, "3")).toEqual({ _tag: "FieldSubmitted" });
        expect(model.submitFieldText(names, '["one","two"]')).toEqual({
            _tag: "FieldSubmitted",
        });
        expect(model.hasDirtySettings()).toBe(true);
    });

    it("shows inherited values separately for global and project layers", () => {
        const model = new SettingsEditorModel(editableCatalog([fixtureExtension()]), true);
        const nestedLabel = fieldIndex(model, "nested.label");
        const nestedVisible = fieldIndex(model, "nested.visible");

        expect(model.fields()[nestedLabel]).toMatchObject({ value: "global", overridden: true });
        expect(model.selectScope("project")).toBe(true);
        expect(model.fields()[nestedLabel]).toMatchObject({ value: "global", overridden: false });
        expect(model.fields()[nestedVisible]).toMatchObject({ value: false, overridden: true });

        expect(model.clearField(nestedVisible)).toEqual({ _tag: "EditApplied" });
        expect(model.fields()[nestedVisible]).toMatchObject({ value: true, overridden: false });
        expect(model.saveRequests()).toHaveLength(1);
        expect(model.saveRequests()[0]?.content).toBe("{}\n");
    });

    it("applies schema-declared sibling defaults when cycling a choice", () => {
        const extension = fixtureExtension();
        const schema = {
            ...extension.schema,
            fields: extension.schema.fields.map((field) =>
                field.path.join(".") === "mode"
                    ? {
                          ...field,
                          choiceDefaults: [
                              { choice: "fast" as const, siblingValues: { threshold: 3 } },
                              { choice: "safe" as const, siblingValues: { threshold: 7 } },
                          ],
                      }
                    : field,
            ),
        };
        const model = new SettingsEditorModel(editableCatalog([{ ...extension, schema }]), true);
        const mode = fieldIndex(model, "mode");
        const threshold = fieldIndex(model, "threshold");

        expect(model.fields()[mode]?.value).toBe("fast");
        expect(model.cycleChoice(mode, 1)).toEqual({ _tag: "EditApplied" });
        expect(model.fields()[mode]?.value).toBe("safe");
        expect(model.fields()[threshold]?.value).toBe(7);
    });

    it("keeps blocked layers read-only and never creates save requests for them", () => {
        const extension = fixtureExtension();
        const model = new SettingsEditorModel(
            editableCatalog([
                {
                    ...extension,
                    global: {
                        _tag: "BlockedLayer",
                        path: "/agent/extension-settings/pi-fixture.json",
                        message: "Settings contain malformed JSON.",
                        issues: [],
                    },
                },
            ]),
            false,
        );
        expect(model.scopeView("global")).toMatchObject({ editable: false });
        expect(model.toggleBoolean(fieldIndex(model, "enabled"))).toMatchObject({
            _tag: "EditRejected",
        });
        expect(model.saveRequests()).toEqual([]);
    });
});
