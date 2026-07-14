import { describe, expect, it } from "vitest";

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
import { testDefinition } from "./fixture.ts";

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
        const rendered = renderReadmeSettingsSection(testDefinition());

        expect(rendered).toContain(
            "Global settings are stored in `~/.pi/agent/extension-settings/pi-example.json`.",
        );
        expect(rendered).toContain('| `appearance.color` | string | `"blue"` | Accent color. |');
        expect(rendered).toContain(
            '| `mode` | `compact` \\| `expanded` | `"compact"` | Display mode. |',
        );
        expect(rendered).toContain('"$schema": "./schemas/pi-example.schema.json"');
        expect(rendered).toContain('"opacity": 0.8');
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

    it.each([
        ["missing markers", "# README"],
        ["reversed markers", `${README_GENERATED_END}\n${README_GENERATED_START}`],
        [
            "duplicate start",
            `${README_GENERATED_START}\n${README_GENERATED_START}\n${README_GENERATED_END}`,
        ],
        [
            "duplicate end",
            `${README_GENERATED_START}\n${README_GENERATED_END}\n${README_GENERATED_END}`,
        ],
    ])("rejects %s", (_label, readme) => {
        expect(replaceGeneratedReadmeSection(readme, "generated")).toBeUndefined();
    });
});
