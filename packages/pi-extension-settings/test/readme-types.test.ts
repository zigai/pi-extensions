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
                    namedEntries: Type.Array(
                        Type.Object(
                            {
                                provider: Type.String(),
                                model: Type.String(),
                                thinkingLevel: Type.Optional(
                                    Type.Enum([
                                        "off",
                                        "minimal",
                                        "low",
                                        "medium",
                                        "high",
                                        "xhigh",
                                        "max",
                                    ]),
                                ),
                                color: Type.Optional(Type.String()),
                            },
                            { additionalProperties: false, title: "ModelMode" },
                        ),
                        { default: [], description: "Named model modes." },
                    ),
                    color: Type.Union(
                        [
                            Type.Integer(),
                            Type.Literal(""),
                            Type.String({ pattern: "^#[0-9a-fA-F]{6}$" }),
                            Type.Enum(["accent", "warning"]),
                        ],
                        { default: "#123456", description: "Display color." },
                    ),
                    primitiveUnion: Type.Union(
                        [
                            Type.Number(),
                            Type.Integer(),
                            Type.Null(),
                            Type.Boolean(),
                            Type.Unsafe({ const: null }),
                            Type.Literal(false),
                            Type.Literal(1),
                            Type.Union([Type.Literal(2), Type.Literal(3)]),
                        ],
                        { default: true, description: "Primitive alternatives." },
                    ),
                    blankTitleEntries: Type.Array(
                        Type.Object(
                            { id: Type.String() },
                            { additionalProperties: false, title: " " },
                        ),
                        { default: [], description: "Entries without a usable title." },
                    ),
                    humanTitleEntries: Type.Array(
                        Type.Object(
                            { id: Type.String() },
                            { additionalProperties: false, title: "Model mode" },
                        ),
                        { default: [], description: "Entries with a human-readable title." },
                    ),
                    backtickChoice: Type.Enum(["plain", "`quoted`", ""], {
                        default: "plain",
                        description: "Values containing Markdown delimiters.",
                    }),
                    "command|`name`": Type.String({
                        default: "run `pi` now",
                        description: "A path and default containing table delimiters.",
                    }),
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
        expect(rendered).toContain("| `limits` | number[] | *See JSON below* | Numeric limits. |");
        expect(rendered).toContain(
            "| `mixed` | (`one` \\| integer)[] | *See JSON below* | Mixed values. |",
        );
        expect(rendered).toContain(
            "| `entries` | { id: string; enabled?: boolean }[] | `[]` | Structured entries. |",
        );
        expect(rendered).toContain(
            "| `entriesByName` | Record<string, { count: integer }> | `{}` | Named entries. |",
        );
        expect(rendered).toContain("| `namedEntries` | ModelMode[] | `[]` | Named model modes. |");
        expect(rendered).toContain('| `color` | integer \\| string | `"#123456"`');
        expect(rendered).toContain(
            "| `primitiveUnion` | number \\| null \\| boolean | `true` | Primitive alternatives. |",
        );
        expect(rendered).toContain(
            "| `blankTitleEntries` | { id: string }[] | `[]` | Entries without a usable title. |",
        );
        expect(rendered).toContain(
            "| `humanTitleEntries` | { id: string }[] | `[]` | Entries with a human-readable title. |",
        );
        expect(rendered).toContain(
            '| `backtickChoice` | `plain` \\| `` `quoted` `` \\| `""` | `"plain"` |',
        );
        expect(rendered).toContain("command\\|`name`");
        expect(rendered).toContain('``"run `pi` now"``');
        expect(rendered).toContain("| `fixed` | `true` | `true` | A fixed boolean. |");
        expect(rendered).toContain(
            "| `tags` | (`stable` \\| `preview`)[] | `[]` | Release tags. |",
        );
        expect(rendered).toContain("| `recursiveEntry` | Entry | — | A recursive entry. |");
        expect(rendered).toContain('| `choice` | `one` \\| `two` | `"one"`');
        expect(rendered).toContain("| `mystery` | JSON value | `null`");
        expect(rendered).not.toContain('"optional"');
        expect(rendered).not.toContain("### Defaults");
        expect(rendered).not.toContain("### Advanced example");
        expect(definition.schemaId).toBe("urn:pi-extension-settings:pi-types");
    });

    it("rejects complex table types without a concise schema title", () => {
        const definition = defineExtensionSettings({
            id: "pi-long-type",
            title: "Pi Long Type",
            description: "Settings with an unreadable inline type.",
            schema: Type.Object(
                {
                    entries: Type.Array(
                        Type.Object(
                            {
                                firstLongPropertyName: Type.String(),
                                secondLongPropertyName: Type.String(),
                                thirdLongPropertyName: Type.String(),
                                fourthLongPropertyName: Type.String(),
                                fifthLongPropertyName: Type.String(),
                            },
                            { additionalProperties: false, title: "Long model configuration" },
                        ),
                        { default: [], description: "Long structured entries." },
                    ),
                },
                { additionalProperties: false },
            ),
        });

        expect(() => renderReadmeSettingsSection(definition)).toThrowError(
            /add a concise PascalCase title/,
        );
    });
});
