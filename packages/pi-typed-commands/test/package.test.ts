import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { compileTypedCommandDefinition, enumArgument, group } from "pi-typed-commands/core";
import { defineTypedCommand } from "pi-typed-commands/pi";
import { normalizeSkillArguments } from "pi-typed-commands/skills";
import { createHeadlessFormModel, type FormMode } from "pi-typed-commands/pi-tui";

void describe("package subpath exports", () => {
    void it("loads the public core, pi, skills, and pi-tui subpaths", () => {
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
        assert.equal(grouped.args.host?.type, "enum");
        assert.equal(compiled.ok, true);
        assert.deepEqual(normalized.warnings, []);
    });

    void it("keeps the published skill JSON schema aligned with compiler-only constraints", () => {
        const schema = JSON.parse(readFileSync("schemas/skill-arguments.schema.json", "utf8")) as {
            $defs: Record<string, { allOf?: Array<{ properties?: Record<string, unknown> }> }>;
        };
        const stringArgument = schema.$defs.stringArgument?.allOf?.[1]?.properties ?? {};
        const numberArgument = schema.$defs.numberArgument?.allOf?.[1]?.properties ?? {};
        const enumArgumentDefinition = schema.$defs.enumArgument?.allOf?.[1]?.properties ?? {};
        const multiEnumArgumentDefinition =
            schema.$defs.multiEnumArgument?.allOf?.[1]?.properties ?? {};

        assert.equal(stringArgument.title, true);
        assert.deepEqual(stringArgument.occurrence, { enum: ["error", "first", "last"] });
        assert.deepEqual(numberArgument.rest, { const: false });
        assert.deepEqual(enumArgumentDefinition.rest, { const: false });
        assert.deepEqual(multiEnumArgumentDefinition.occurrence, true);
        assert.deepEqual((enumArgumentDefinition.values as { items?: unknown }).items, {
            type: "string",
            minLength: 1,
        });
        assert.deepEqual((multiEnumArgumentDefinition.default as { items?: unknown }).items, {
            type: "string",
            minLength: 1,
        });
    });
});
