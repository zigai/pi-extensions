import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import {
    defineTypedCommand as defineLeanTypedCommand,
    registerTypedCommand,
    type TypedCommandGhostTextContext,
} from "pi-typed-args/command";
import { compileTypedCommandDefinition, enumArgument, group } from "pi-typed-args/core";
import { createTypedCommandUxExtension, defineTypedCommand } from "pi-typed-args/pi";
import {
    normalizeSkillArguments,
    readTypedSkillMetadataResult,
    skillArgumentsJsonSchema,
    type SkillFrontmatterMetadata,
} from "pi-typed-args/skills";
import { createHeadlessFormModel, type FormMode } from "pi-typed-args/pi-tui";
import exportedSkillSchema from "pi-typed-args/schema" with { type: "json" };
import {
    DEFAULT_PI_TYPED_COMMANDS_CONFIG_JSON,
    piTypedCommandsConfigJsonSchema,
} from "../src/pi/config-schema.js";

function configurationJsonBlock(path: string): unknown {
    const source = readFileSync(path, "utf8");
    const heading = source.search(/^#{1,2} Configuration$/mu);
    assert.notEqual(heading, -1, `${path} must contain a Configuration section`);
    const match = /```json\n([\s\S]*?)\n```/u.exec(source.slice(heading));
    assert.ok(match, `${path} must contain a JSON configuration block`);
    return JSON.parse(match[1] ?? "");
}

describe("package subpath exports", () => {
    it("loads the public core, pi, skills, and pi-tui subpaths", () => {
        const mode: FormMode = "all";

        const ghostContextLabel = (context: TypedCommandGhostTextContext): string =>
            context.commandName;

        const skillMetadata: SkillFrontmatterMetadata = { ghostText: "Choose a target" };
        const command = defineTypedCommand({
            name: "subpath-demo",
            description: "Subpath demo",
            args: {
                env: enumArgument(["dev", "prod"], { required: true }),
            },
            run() {},
        });
        const compiled = compileTypedCommandDefinition(command);
        const grouped = group({ host: enumArgument(["primary", "replica"]) });
        const normalized = normalizeSkillArguments({
            env: { type: "enum", values: ["dev", "prod"] },
        });

        const model = createHeadlessFormModel(
            command.args,
            {
                values: {},
                provided: new Set(),
                issues: [],
                mode: "run",
            },
            mode,
        );

        assert.equal(model.fields.length, 1);
        assert.equal(typeof createTypedCommandUxExtension, "function");
        assert.equal(typeof defineLeanTypedCommand, "function");
        assert.equal(typeof registerTypedCommand, "function");
        assert.equal(typeof readTypedSkillMetadataResult, "function");
        assert.equal(skillMetadata.ghostText, "Choose a target");
        assert.equal(typeof ghostContextLabel, "function");
        assert.equal(grouped.args.host?.type, "enum");
        assert.equal(compiled.ok, true);
        assert.deepEqual(normalized.diagnostics, []);
    });

    it("keeps the published skill JSON schema aligned with the TypeBox source", () => {
        const schema: unknown = JSON.parse(
            readFileSync("schemas/skill-arguments.schema.json", "utf8"),
        );

        assert.deepEqual(schema, skillArgumentsJsonSchema());
        assert.deepEqual(exportedSkillSchema, schema);
    });

    it("keeps user-facing configuration blocks aligned with the scaffolded defaults", () => {
        assert.deepEqual(
            configurationJsonBlock("README.md"),
            DEFAULT_PI_TYPED_COMMANDS_CONFIG_JSON,
        );
        assert.deepEqual(
            configurationJsonBlock("docs/configuration.md"),
            DEFAULT_PI_TYPED_COMMANDS_CONFIG_JSON,
        );
    });

    it("keeps the published config JSON schema aligned with the TypeBox source", () => {
        const schema: unknown = JSON.parse(readFileSync("config.schema.json", "utf8"));
        assert.deepEqual(schema, piTypedCommandsConfigJsonSchema());
    });
});
