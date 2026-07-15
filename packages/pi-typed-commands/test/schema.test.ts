import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileTypedCommandDefinition } from "../src/compiler.js";
import {
    applyArgumentDefaults,
    argumentValueHint,
    coerceArgumentValue,
    createArgumentLookup,
    findArgumentName,
    orderedArgumentEntries,
    validateArgumentDefinitions,
    validateArgumentValue,
} from "../src/schema.js";
import type { ArgumentDefinition, FlatArgumentDefinitions } from "../src/types.js";

const definitions: FlatArgumentDefinitions = {
    action: {
        type: "enum",
        values: ["create", "delete"],
        required: true,
        position: 0,
    },
    branchName: {
        type: "string",
        required: true,
        position: 1,
        minLength: 1,
        pattern: "^[a-zA-Z0-9/_-]+$",
    },
    dryRun: {
        type: "boolean",
    },
    count: {
        type: "number",
        integer: true,
        min: 1,
        max: 3,
        default: 1,
    },
};

function definitionNamed(name: string): ArgumentDefinition {
    const definition = definitions[name];
    assert.ok(definition, `missing ${name} definition`);
    return definition;
}

describe("typed command schema", () => {
    it("orders positional args before flags", () => {
        assert.deepEqual(
            orderedArgumentEntries(definitions).map(([name]) => name),
            ["action", "branchName", "dryRun", "count"],
        );
    });

    it("centralizes flag lookup and positional exclusion", () => {
        const lookup = createArgumentLookup(definitions);

        assert.equal(findArgumentName(lookup, "--dry-run"), "dryRun");
        assert.equal(findArgumentName(lookup, "--action"), undefined);
    });

    it("excludes valid form-only arguments from CLI lookup", () => {
        const formDefinitions = {
            task: { type: "string", position: 0 },
            maximumTimeMinutes: { type: "number", formOnly: true },
        } satisfies FlatArgumentDefinitions;
        const diagnostics = validateArgumentDefinitions(formDefinitions);
        const lookup = createArgumentLookup(formDefinitions);

        assert.deepEqual(diagnostics, []);
        assert.equal(findArgumentName(lookup, "--maximum-time-minutes"), undefined);
    });

    it("rejects form-only requiredness, defaults, and CLI metadata", () => {
        const diagnostics = validateArgumentDefinitions({
            requiredValue: { type: "number", formOnly: true, required: true },
            defaultValue: { type: "number", formOnly: true, default: 1 },
            flaggedValue: { type: "number", formOnly: true, flag: "minutes" },
            aliasedValue: { type: "number", formOnly: true, aliases: ["m"] },
            positionalValue: { type: "number", formOnly: true, position: 0 },
            restValue: { type: "string", formOnly: true, rest: true },
        });
        const codes = diagnostics.map((diagnostic) => diagnostic.code);

        assert.ok(codes.includes("argument.form-only.required"));
        assert.ok(codes.includes("argument.form-only.default"));
        assert.equal(
            codes.filter((code) => code === "argument.form-only.cli-metadata").length,
            4,
        );
    });

    it("coerces and validates values consistently", () => {
        const count = definitions.count;
        assert.equal(count?.type, "number");
        if (count === undefined) {
            throw new Error("count definition missing");
        }

        assert.deepEqual(coerceArgumentValue(count, "2", "count"), { ok: true, value: 2 });
        assert.equal(coerceArgumentValue(count, "4", "count").ok, false);
        assert.deepEqual(validateArgumentValue("count", count, 2), { ok: true });
        assert.deepEqual(validateArgumentValue("count", count, 2.5), {
            ok: false,
            message: "--count expects an integer",
        });
        const branchName = definitionNamed("branchName");
        assert.deepEqual(validateArgumentValue("branchName", branchName, ""), {
            ok: false,
            message: "--branch-name must be at least 1 characters",
        });
        assert.deepEqual(
            validateArgumentValue("branchName", branchName, "bad branch"),
            {
                ok: false,
                message: "--branch-name must match pattern ^[a-zA-Z0-9/_-]+$",
            },
        );
        assert.deepEqual(
            validateArgumentValue("branchName", branchName, "", {
                nameStyle: "field",
            }),
            {
                ok: false,
                message: "branch-name must be at least 1 characters",
            },
        );
    });

    it("applies defaults and derives display hints", () => {
        assert.deepEqual(applyArgumentDefaults(definitions, {}), { count: 1 });
        assert.equal(argumentValueHint(definitionNamed("branchName"), "branchName"), "branch-name");
        assert.equal(argumentValueHint(definitionNamed("action"), "action"), "create|delete");
    });

    it("compiles arguments into immutable behavior objects", () => {
        const compiled = compileTypedCommandDefinition({
            name: "deploy",
            description: "Deploy",
            args: definitions,
        });

        assert.equal(compiled.ok, true);
        if (compiled.ok) {
            const action = compiled.command.argumentByName.get("action");
            assert.equal(action?.describe().position, 0);
            assert.deepEqual(action?.serialize("create"), ["--action=create"]);
            assert.deepEqual(action?.decode([{ source: "positional", raw: "delete" }]), {
                ok: true,
                value: "delete",
            });
            assert.equal("set" in compiled.command.argumentByName, false);
            assert.equal("set" in compiled.command.flagToName, false);
        }
    });

    it("validates schema constraints before registration", () => {
        const diagnostics = validateArgumentDefinitions({
            range: { type: "number", min: 10, max: 1 },
            text: { type: "string", minLength: 5, maxLength: 2, pattern: "[" },
            choice: { type: "enum", values: ["dev", "dev", ""] },
            many: { type: "multi-enum", values: ["a"], minItems: 3, maxItems: 1 },
            commaMulti: { type: "multi-enum", values: ["a,b"] },
            badCompletionTimeout: { type: "string", completionTimeoutMs: -1 },
            defaulted: { type: "string", required: true, default: "main" },
            first: { type: "string", position: 0 },
            second: { type: "string", required: true, position: 1 },
            duplicatePosition: { type: "string", position: 1 },
            badTitle: { type: "string", title: 123 },
            badRows: { type: "string", ui: { rows: 0 } },
            restBeforeOther: { type: "string", position: 2, rest: true },
            afterRest: { type: "string", position: 3 },
        });
        const text = diagnostics.map((diagnostic) => diagnostic.message).join("\n");

        assert.match(text, /range\.min must be less than or equal to max/);
        assert.match(text, /text\.minLength must be less than or equal to maxLength/);
        assert.match(text, /text\.pattern must be a valid regular expression/);
        assert.match(text, /choice\.values contains duplicate value dev/);
        assert.match(text, /choice\.values may not contain empty strings/);
        assert.match(text, /many\.minItems must be less than or equal to maxItems/);
        assert.match(text, /commaMulti\.values may not contain commas/);
        assert.match(
            text,
            /badCompletionTimeout\.completionTimeoutMs must be a non-negative integer/,
        );
        assert.match(text, /defaulted: required arguments may not define a default/);
        assert.match(
            text,
            /second: required positional arguments may not follow optional positional argument first/,
        );
        assert.match(text, /duplicatePosition\.position duplicates position 1 from second/);
        assert.match(text, /badTitle\.title must be a string/);
        assert.match(text, /badRows\.ui\.rows must be a positive integer/);
        assert.match(
            text,
            /afterRest: positional arguments may not follow rest argument restBeforeOther/,
        );
        assert.ok(
            diagnostics.some(
                (diagnostic) =>
                    diagnostic.code === "argument.number.range.invalid" &&
                    diagnostic.path.join(".") === "range.min",
            ),
        );
    });

    it("returns diagnostics for malformed runtime definitions instead of throwing", () => {
        class BehaviorBearingDefinition {
            readonly type = "string";

            describe(): string {
                return "unsupported behavior";
            }
        }

        const diagnostics = validateArgumentDefinitions({
            stringValues: { type: "enum", values: "abc" },
            numericValues: { type: "enum", values: [1, 2] },
            numericFlag: { type: "string", flag: 123 },
            stringAliases: { type: "string", aliases: "x" },
            unknownType: { type: "date" },
            missingDefinition: null,
            stringRequired: { type: "string", required: "yes" },
            stringInteger: { type: "number", integer: "yes" },
            behaviorBearing: new BehaviorBearingDefinition(),
        });
        const text = diagnostics.map((diagnostic) => diagnostic.message).join("\n");

        assert.match(text, /stringValues\.values must be a list of strings/);
        assert.match(text, /numericValues\.values\[0\] must be a string/);
        assert.match(text, /numericFlag\.flag must be a string/);
        assert.match(text, /stringAliases\.aliases must be a list of strings/);
        assert.match(text, /unknownType\.type must be one of/);
        assert.match(text, /missingDefinition: argument definition must be an object/);
        assert.match(text, /stringRequired\.required must be a boolean/);
        assert.match(text, /stringInteger\.integer must be a boolean/);
        assert.match(text, /behaviorBearing: argument definition must be a plain object/);

        assert.deepEqual(validateArgumentDefinitions(null), [
            {
                code: "arguments.invalid",
                message: "arguments must be an object",
                path: [],
                severity: "error",
            },
        ]);
    });
});
