import { describe, expect, it } from "vitest";
import { Type } from "typebox";

import { defineExtensionSettings } from "../src/definition.ts";
import { renderReadmeSettingsSection } from "../src/settings-documentation.ts";

describe("README schema rendering", () => {
    it("documents optional values, arrays, and escaped descriptions", () => {
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
        expect(rendered).toContain("| `limits` | number[] | `[1,2]` | Numeric limits. |");
        expect(rendered).toContain(
            '| `mixed` | (`one` \\| integer)[] | `["one"]` | Mixed values. |',
        );
        expect(rendered).toContain('| `choice` | `one` \\| `two` | `"one"`');
        expect(rendered).toContain("| `mystery` | unknown | `null`");
        expect(rendered).not.toContain('"optional"');
        expect(definition.schemaId).toBe("urn:pi-extension-settings:pi-types");
    });
});
