import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import {
    defineTypedCommand as defineLeanTypedCommand,
    registerTypedCommand,
} from "pi-typed-args/command";
import { compileTypedCommandDefinition, enumArgument, group } from "pi-typed-args/core";
import { createTypedCommandUxExtension, defineTypedCommand } from "pi-typed-args/pi";
import {
    normalizeSkillArguments,
    readTypedSkillMetadataResult,
    skillArgumentsJsonSchema,
} from "pi-typed-args/skills";
import { createHeadlessFormModel, type FormMode } from "pi-typed-args/pi-tui";
import { piTypedCommandsConfigJsonSchema } from "../src/pi/config-schema.js";

describe("package subpath exports", () => {
    it("loads the public core, pi, skills, and pi-tui subpaths", () => {
        const mode: FormMode = "all";
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
        assert.equal(grouped.args.host?.type, "enum");
        assert.equal(compiled.ok, true);
        assert.deepEqual(normalized.diagnostics, []);
    });

    it("keeps the published skill JSON schema aligned with the TypeBox source", () => {
        const schema: unknown = JSON.parse(
            readFileSync("schemas/skill-arguments.schema.json", "utf8"),
        );

        assert.deepEqual(schema, skillArgumentsJsonSchema());
    });

    it("keeps the published config JSON schema aligned with the TypeBox source", () => {
        const schema: unknown = JSON.parse(readFileSync("config.schema.json", "utf8"));

        assert.deepEqual(schema, piTypedCommandsConfigJsonSchema());
    });
});
