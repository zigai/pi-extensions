import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
import type { FlatArgumentDefinitions } from "../src/types.js";

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

void describe("typed command schema", () => {
    void it("orders positional args before flags", () => {
        assert.deepEqual(
            orderedArgumentEntries(definitions).map(([name]) => name),
            ["action", "branchName", "dryRun", "count"],
        );
    });

    void it("centralizes flag lookup and positional exclusion", () => {
        const lookup = createArgumentLookup(definitions);

        assert.equal(findArgumentName(lookup, "--dry-run"), "dryRun");
        assert.equal(findArgumentName(lookup, "--action"), undefined);
    });

    void it("coerces and validates values consistently", () => {
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
        assert.deepEqual(validateArgumentValue("branchName", definitions.branchName!, ""), {
            ok: false,
            message: "--branch-name must be at least 1 characters",
        });
        assert.deepEqual(
            validateArgumentValue("branchName", definitions.branchName!, "bad branch"),
            {
                ok: false,
                message: "--branch-name must match pattern ^[a-zA-Z0-9/_-]+$",
            },
        );
        assert.deepEqual(
            validateArgumentValue("branchName", definitions.branchName!, "", {
                nameStyle: "field",
            }),
            {
                ok: false,
                message: "branch-name must be at least 1 characters",
            },
        );
    });

    void it("applies defaults and derives display hints", () => {
        assert.deepEqual(applyArgumentDefaults(definitions, {}), { count: 1 });
        assert.equal(argumentValueHint(definitions.branchName!, "branchName"), "branch-name");
        assert.equal(argumentValueHint(definitions.action!, "action"), "create|delete");
    });

    void it("compiles arguments into immutable behavior objects", () => {
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

    void it("validates schema constraints before registration", () => {
        const diagnostics = validateArgumentDefinitions({
            range: { type: "number", min: 10, max: 1 },
            text: { type: "string", minLength: 5, maxLength: 2, pattern: "[" },
            choice: { type: "enum", values: ["dev", "dev", ""] },
            many: { type: "multi-enum", values: ["a"], minItems: 3, maxItems: 1 },
            commaMulti: { type: "multi-enum", values: ["a,b"] },
            badCompletionTimeout: { type: "string", completionTimeoutMs: -1 },
            defaulted: { type: "string", required: true, default: "main" } as never,
            first: { type: "string", position: 0 },
            second: { type: "string", required: true, position: 1 },
            duplicatePosition: { type: "string", position: 1 },
            badTitle: { type: "string", title: 123 as never },
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

    void it("returns diagnostics for malformed runtime definitions instead of throwing", () => {
        const compiled = compileTypedCommandDefinition({
            name: "bad-runtime",
            description: "Bad runtime definitions",
            args: {
                stringValues: { type: "enum", values: "abc" },
                numericValues: { type: "enum", values: [1, 2] },
                numericFlag: { type: "string", flag: 123 },
                stringAliases: { type: "string", aliases: "x" },
                unknownType: { type: "date" },
                missingDefinition: null,
                stringRequired: { type: "string", required: "yes" },
                stringInteger: { type: "number", integer: "yes" },
                // SAFETY: this test intentionally bypasses compile-time definition checks to
                // exercise diagnostics for JavaScript/runtime callers.
            } as never,
        });

        assert.equal(compiled.ok, false);
        if (compiled.ok) {
            assert.fail("malformed runtime definitions should not compile");
        }
        const text = compiled.diagnostics.map((diagnostic) => diagnostic.message).join("\n");

        assert.match(text, /stringValues\.values must be a list of strings/);
        assert.match(text, /numericValues\.values\[0\] must be a string/);
        assert.match(text, /numericFlag\.flag must be a string/);
        assert.match(text, /stringAliases\.aliases must be a list of strings/);
        assert.match(text, /unknownType\.type must be one of/);
        assert.match(text, /missingDefinition: argument definition must be an object/);
        assert.match(text, /stringRequired\.required must be a boolean/);
        assert.match(text, /stringInteger\.integer must be a boolean/);

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
