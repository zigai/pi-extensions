import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileTypedCommandDefinition } from "pi-typed-commands/core";
import { defineTypedCommand } from "pi-typed-commands/pi";
import { normalizeSkillArguments } from "pi-typed-commands/skills";
import type { FormMode } from "pi-typed-commands/pi-tui";

void describe("package subpath exports", () => {
    void it("loads the public core, pi, skills, and pi-tui subpaths", () => {
        const mode: FormMode = "all";
        const command = defineTypedCommand({
            name: "subpath-demo",
            description: "Subpath demo",
            args: {
                env: { type: "enum", values: ["dev", "prod"], required: true },
            },
            run() {},
        });
        const compiled = compileTypedCommandDefinition(command);
        const normalized = normalizeSkillArguments({
            env: { type: "enum", values: ["dev", "prod"] },
        });

        assert.equal(mode, "all");
        assert.equal(compiled.ok, true);
        assert.deepEqual(normalized.warnings, []);
    });
});
