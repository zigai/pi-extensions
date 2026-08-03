import { describe, expect, it } from "vitest";
import { Type } from "typebox";

import { defineExtensionSettings } from "../src/definition.ts";
import { renderReadmeSettingsSection } from "../src/settings-documentation.ts";

describe("README schema rendering", () => {
    it("documents optional values, arrays, and escaped descriptions", () => {
        const recursiveEntry = Type.Cyclic(
            {
                Entry: Type.Object(
                    {
                        name: Type.String(),
                        child: Type.Optional(Type.Ref("Entry")),
                    },
                    { additionalProperties: false },
                ),
            },
            "Entry",
            { description: "A recursive entry." },
        );
        const definition = defineExtensionSettings({
            id: "pi-types",
            title: "Pi Types",
            description: "Type rendering settings.",
            schema: Type.Object(
                {
                    required: Type.Boolean({ default: true, description: "Required setting." }),
                    optional: Type.Optional(
                        Type.String({ description: "Optional | setting.\nSecond line." }),
                    ),
                    limits: Type.Array(Type.Number(), {
                        default: [1, 2],
                        description: "Numeric limits.",
                    }),
                    mixed: Type.Array(Type.Union([Type.Literal("one"), Type.Integer()]), {
                        default: ["one"],
                        description: "Mixed values.",
                    }),
                    entries: Type.Array(
                        Type.Object(
                            {
                                id: Type.String(),
                                enabled: Type.Optional(Type.Boolean()),
                            },
                            { additionalProperties: false },
                        ),
                        { default: [], description: "Structured entries." },
                    ),
                    entriesByName: Type.Record(
                        Type.String(),
                        Type.Object({ count: Type.Integer() }, { additionalProperties: false }),
                        { default: {}, description: "Named entries." },
                    ),
                    fixed: Type.Literal(true, {
                        default: true,
                        description: "A fixed boolean.",
                    }),
                    tags: Type.Array(Type.Enum(["stable", "preview"]), {
                        default: [],
                        description: "Release tags.",
                    }),
                    recursiveEntry: Type.Optional(recursiveEntry),
                    choice: Type.Enum(["one", "two"], {
                        default: "one",
                        description: "An enumerated choice.",
                    }),
                    mystery: Type.Any({
                        default: null,
                        description: "An unconstrained value.",
                    }),
                },
                { additionalProperties: false },
            ),
        });

        const rendered = renderReadmeSettingsSection(definition);

        expect(rendered).toContain("| `required` | boolean | `true` | Required setting. |");
        expect(rendered).toContain(
            "| `optional` | string | — | Optional \\| setting. Second line. |",
        );
        expect(rendered).toContain(
            "| `limits` | number[] | *See JSON below ↓* | Numeric limits. |",
        );
        expect(rendered).toContain(
            "| `mixed` | (`one` \\| integer)[] | *See JSON below ↓* | Mixed values. |",
        );
        expect(rendered).toContain(
            "| `entries` | { id: string; enabled?: boolean }[] | `[]` | Structured entries. |",
        );
        expect(rendered).toContain(
            "| `entriesByName` | Record<string, { count: integer }> | `{}` | Named entries. |",
        );
        expect(rendered).toContain("| `fixed` | `true` | `true` | A fixed boolean. |");
        expect(rendered).toContain(
            "| `tags` | (`stable` \\| `preview`)[] | `[]` | Release tags. |",
        );
        expect(rendered).toContain("| `recursiveEntry` | Entry | — | A recursive entry. |");
        expect(rendered).toContain('| `choice` | `one` \\| `two` | `"one"`');
        expect(rendered).toContain("| `mystery` | JSON value | `null`");
        expect(rendered).not.toContain('"optional"');
        expect(definition.schemaId).toBe("urn:pi-extension-settings:pi-types");
    });
});
