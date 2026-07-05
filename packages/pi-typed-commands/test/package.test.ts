import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import {
    defineTypedCommand as defineLeanTypedCommand,
    registerTypedCommand,
} from "pi-typed-commands/command";
import { compileTypedCommandDefinition, enumArgument, group } from "pi-typed-commands/core";
import { createTypedCommandUxExtension, defineTypedCommand } from "pi-typed-commands/pi";
import { normalizeSkillArguments, skillArgumentsJsonSchema } from "pi-typed-commands/skills";
import { createHeadlessFormModel, type FormMode } from "pi-typed-commands/pi-tui";
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
        assert.equal(grouped.args.host?.type, "enum");
        assert.equal(compiled.ok, true);
        assert.deepEqual(normalized.diagnostics, []);
    });

    it("keeps the published skill JSON schema aligned with the TypeBox source", () => {
        const schema = JSON.parse(readFileSync("schemas/skill-arguments.schema.json", "utf8"));

        assert.deepEqual(schema, skillArgumentsJsonSchema());
    });

    it("keeps the published config JSON schema aligned with the TypeBox source", () => {
        const schema = JSON.parse(readFileSync("config.schema.json", "utf8"));

        assert.deepEqual(schema, piTypedCommandsConfigJsonSchema());
    });
});
