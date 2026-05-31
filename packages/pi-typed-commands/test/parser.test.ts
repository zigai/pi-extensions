import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getTypedAutocompleteSuggestions } from "../src/completions.js";
import { parseTypedCommandArgs, type RegisteredTypedCommand } from "../src/index.js";
import { registerTypedCommandMetadata } from "../src/registry.js";

const command: RegisteredTypedCommand = {
    name: "deploy",
    description: "Deploy a ref",
    args: {
        env: {
            type: "enum",
            values: ["dev", "staging", "prod"],
            required: true,
            description: "Target environment",
        },
        ref: {
            type: "string",
            default: "main",
            description: "Git ref",
        },
        dryRun: {
            type: "boolean",
            description: "Preview only",
        },
        count: {
            type: "number",
            integer: true,
            min: 1,
            max: 5,
        },
    },
    handler: () => {},
    typedArgsEnabled: true,
    manualWizardToken: "?",
    helpToken: "??",
    openWizardWhenInvalid: true,
    openWizardWhenMissingRequired: true,
};

void describe("parseTypedCommandArgs", () => {
    void it("parses named enum, string, boolean, and number args", () => {
        const parsed = parseTypedCommandArgs(
            command,
            "--env staging --dry-run --ref feature/test --count 3",
        );

        assert.equal(parsed.mode, "run");
        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.env, "staging");
        assert.equal(parsed.values.dryRun, true);
        assert.equal(parsed.values.ref, "feature/test");
        assert.equal(parsed.values.count, 3);
    });

    void it("applies defaults and reports missing required args", () => {
        const parsed = parseTypedCommandArgs(command, "");

        assert.equal(parsed.values.ref, "main");
        assert.equal(parsed.issues.length, 1);
        assert.equal(parsed.issues[0]?.kind, "missing-required");
        assert.equal(parsed.issues[0]?.name, "env");
    });

    void it("supports no-boolean flags", () => {
        const parsed = parseTypedCommandArgs(command, "--env dev --no-dry-run");

        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.dryRun, false);
    });

    void it("recognizes wizard and help tokens", () => {
        const wizard = parseTypedCommandArgs(command, "?");
        const help = parseTypedCommandArgs(command, "??");
        const wizardWithArgs = parseTypedCommandArgs(command, "--env staging ?");

        assert.equal(wizard.mode, "wizard");
        assert.equal(help.mode, "help");
        assert.equal(wizardWithArgs.mode, "wizard");
        assert.deepEqual(wizardWithArgs.issues, []);
        assert.equal(wizardWithArgs.values.env, "staging");
    });
});

void describe("getTypedAutocompleteSuggestions", () => {
    void it("suggests flags for typed commands", () => {
        registerTypedCommandMetadata(command);

        const suggestions = getTypedAutocompleteSuggestions(["/deploy --e"], 0, 11);

        assert.equal(suggestions?.prefix, "--e");
        assert.deepEqual(
            suggestions?.items.map((item) => item.label),
            ["--env"],
        );
    });

    void it("hides completions for disabled typed commands", () => {
        registerTypedCommandMetadata({
            ...command,
            name: "disabled-deploy",
            typedArgsEnabled: false,
        });

        const suggestions = getTypedAutocompleteSuggestions(["/disabled-deploy --e"], 0, 20);

        assert.equal(suggestions, undefined);
    });
});
