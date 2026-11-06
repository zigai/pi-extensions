import { Type } from "typebox";

import { describe, expect, it } from "vitest";

import { defineExtensionSettings } from "../src/definition.ts";
import {
    defaultGlobalSettingsDisplayPath,
    resolveGlobalSettingsPaths,
    resolveProjectSettingsPaths,
} from "../src/paths.ts";
import {
    README_GENERATED_END,
    README_GENERATED_START,
    renderReadmeSettingsSection,
    replaceGeneratedReadmeSection,
} from "../src/settings-documentation.ts";
import { testDefinition, unpadTables } from "./fixture.ts";

describe("settings paths", () => {
    it("centralizes global configs and schemas", () => {
        expect(resolveGlobalSettingsPaths("/agent", "pi-example")).toEqual({
            configPath: "/agent/extension-settings/pi-example.json",
            schemaPath: "/agent/extension-settings/schemas/pi-example.schema.json",
            schemaReference: "./schemas/pi-example.schema.json",
        });

        expect(defaultGlobalSettingsDisplayPath("pi-example")).toBe(
            "~/.pi/agent/extension-settings/pi-example.json",
        );
    });

    it("uses the configured Pi project directory name", () => {
        expect(resolveProjectSettingsPaths("/project", ".brand", "pi-example")).toEqual({
            configPath: "/project/.brand/extension-settings/pi-example.json",
            schemaPath: "/project/.brand/extension-settings/schemas/pi-example.schema.json",
            schemaReference: "./schemas/pi-example.schema.json",
        });
    });
});

describe("README generation", () => {
    it("renders flattened settings and the complete defaults", () => {
        const rendered = unpadTables(renderReadmeSettingsSection(testDefinition()));

        expect(rendered).toContain(
            "Global settings are stored in `~/.pi/agent/extension-settings/pi-example.json`.",
        );

        expect(rendered).toContain('| `appearance.color` | string | `"blue"` | Accent color. |');
        expect(rendered).toContain(
            '| `mode` | `compact` \\| `expanded` | `"compact"` | Display mode. |',
        );

        expect(rendered).toContain('"$schema": "./schemas/pi-example.schema.json"');
        expect(rendered).toContain('"opacity": 0.8');
        expect(rendered).toContain(
            "| `tools` | string[] | *See JSON below* | Enabled tool names. |",
        );

        expect(rendered).toContain(
            "| `tools` | string[] | *See JSON below* | Enabled tool names. |\n\n### Defaults\n\n```json",
        );

        expect(rendered).not.toContain("Complete default settings");
        expect(rendered).not.toContain("<details>");
    });

    it("aligns every table column to its widest cell", () => {
        const entry = Type.Object(
            {
                id: Type.String({ description: "Identifier." }),
                weight: Type.Number({ description: "Relative weight in the ranking pipeline." }),
            },
            { title: "Entry", additionalProperties: false },
        );
        const definition = defineExtensionSettings({
            id: "pi-aligned",
            title: "Pi Aligned",
            description: "Settings whose table cells differ in width.",
            schema: Type.Object(
                {
                    on: Type.Boolean({ default: true, description: "Résumé café." }),
                    separatorCharacter: Type.String({
                        default: "|",
                        description: "Character between a | b.",
                    }),
                    entries: Type.Array(entry, { default: [], description: "Entries." }),
                },
                { additionalProperties: false },
            ),
        });

        const lines = renderReadmeSettingsSection(definition).split("\n");
        const tables: string[][] = [];
        for (const [index, line] of lines.entries()) {
            if (!line.startsWith("|")) continue;
            if (lines[index - 1]?.startsWith("|")) tables.at(-1)?.push(line);
            else tables.push([line]);
        }

        expect(tables).toHaveLength(2);
        for (const table of tables) {
            const pipeColumns = table.map((line) =>
                [...line].flatMap((character, column, characters) =>
                    character === "|" && characters[column - 1] !== "\\" ? [column] : [],
                ),
            );
            for (const columns of pipeColumns) expect(columns).toEqual(pipeColumns[0]);
            expect(table[1]).toMatch(/^\| -+( \| -+)* \|$/);
        }
    });

    it("keeps long defaults out of the option table without losing their exact values", () => {
        const definition = defineExtensionSettings({
            id: "pi-verbose",
            title: "Pi Verbose",
            description: "Settings with defaults that do not fit readable table cells.",
            schema: Type.Object(
                {
                    prompt: Type.String({
                        default: "First line.\nSecond line.",
                        description: "Prompt text.",
                    }),
                    label: Type.String({
                        default:
                            "A deliberately long single-line default that should not widen the table.",
                        description: "Display label.",
                    }),
                },
                { additionalProperties: false },
            ),
        });

        const rendered = unpadTables(renderReadmeSettingsSection(definition));

        expect(rendered).toContain("| `prompt` | string | *See JSON below* | Prompt text. |");
        expect(rendered).toContain("| `label` | string | *See JSON below* | Display label. |");
        expect(rendered).toContain('"prompt": "First line.\\nSecond line."');
        expect(rendered).toContain(
            '"label": "A deliberately long single-line default that should not widen the table."',
        );
    });

    it("supports a custom user-facing path", () => {
        expect(
            renderReadmeSettingsSection(testDefinition(), {
                globalPath: "$PI_AGENT_DIR/extension-settings/pi-example.json",
            }),
        ).toContain("`$PI_AGENT_DIR/extension-settings/pi-example.json`");
    });

    it("replaces exactly one generated region", () => {
        const original = `# Package\n\n${README_GENERATED_START}\nold\n${README_GENERATED_END}\n\nEnd\n`;
        expect(replaceGeneratedReadmeSection(original, "## New\n\nContent")).toBe(
            `# Package\n\n${README_GENERATED_START}\n## New\n\nContent\n${README_GENERATED_END}\n\nEnd\n`,
        );
    });

    it("appends a generated region when markers are absent", () => {
        expect(replaceGeneratedReadmeSection("# README", "generated")).toBe(
            `# README\n\n${README_GENERATED_START}\ngenerated\n${README_GENERATED_END}\n`,
        );
    });

    it.each([
        ["reversed markers", `${README_GENERATED_END}\n${README_GENERATED_START}`],
        [
            "duplicate start",
            `${README_GENERATED_START}\n${README_GENERATED_START}\n${README_GENERATED_END}`,
        ],
        [
            "duplicate end",
            `${README_GENERATED_START}\n${README_GENERATED_END}\n${README_GENERATED_END}`,
        ],
    ])("rejects invalid %s", (_label, readme) => {
        expect(replaceGeneratedReadmeSection(readme, "generated")).toBeUndefined();
    });
});
