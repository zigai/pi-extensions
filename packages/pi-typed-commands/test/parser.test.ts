import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getTypedAutocompleteSuggestions } from "../src/completions.js";
import {
    formatCommandUsage,
    parseTypedCommandArgs,
    type RegisteredTypedCommand,
} from "../src/index.js";
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
        tags: {
            type: "multi-enum",
            values: ["api", "web", "worker"],
        },
    },
    handler: () => {},
    typedArgsEnabled: true,
    manualFormToken: "?",
    manualWizardToken: "?",
    helpToken: "??",
    formSymbols: {
        selectedCheckbox: "■",
        unselectedCheckbox: "□",
        selectedRadio: "●",
        unselectedRadio: "○",
    },
    openFormWhenInvalid: true,
    openWizardWhenInvalid: true,
    openFormWhenMissingRequired: true,
    openWizardWhenMissingRequired: true,
};

const branchCommand: RegisteredTypedCommand = {
    ...command,
    name: "branch",
    description: "Manage branches",
    args: {
        action: {
            type: "enum",
            values: ["create", "delete", "rename"],
            required: true,
            positional: 0,
            description: "Branch action",
        },
        name: {
            type: "string",
            required: true,
            positional: 1,
            description: "Branch name",
        },
        base: {
            type: "string",
            placeholder: "branch",
            description: "Source branch",
        },
        checkout: {
            type: "boolean",
            description: "Check out after create",
        },
    },
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

    void it("parses multi-enum comma lists and repeated flags", () => {
        const parsed = parseTypedCommandArgs(command, "--env dev --tags api,web --tags worker");

        assert.deepEqual(parsed.issues, []);
        assert.deepEqual(parsed.values.tags, ["api", "web", "worker"]);
    });

    void it("parses positional args before named flags", () => {
        const parsed = parseTypedCommandArgs(branchCommand, "create feature/foo --base main");

        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.action, "create");
        assert.equal(parsed.values.name, "feature/foo");
        assert.equal(parsed.values.base, "main");
    });

    void it("recognizes form and help tokens", () => {
        const form = parseTypedCommandArgs(command, "?");
        const help = parseTypedCommandArgs(command, "??");
        const formWithArgs = parseTypedCommandArgs(command, "--env staging ?");

        assert.equal(form.mode, "form");
        assert.equal(help.mode, "help");
        assert.equal(formWithArgs.mode, "form");
        assert.deepEqual(formWithArgs.issues, []);
        assert.equal(formWithArgs.values.env, "staging");
    });
});

void describe("formatCommandUsage", () => {
    void it("renders positional args before flags", () => {
        assert.equal(
            formatCommandUsage(branchCommand),
            "/branch action:create | delete | rename name [--base=branch] [--checkout]",
        );
    });

    void it("can render explicit types", () => {
        assert.equal(
            formatCommandUsage(branchCommand, { showTypes: true }),
            "/branch action:create | delete | rename name:string [--base=string] [--checkout]",
        );
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
