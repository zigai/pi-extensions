import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    applyArgumentDefaults,
    argumentValueHint,
    coerceArgumentValue,
    createArgumentLookup,
    findArgumentName,
    orderedArgumentEntries,
    validateArgumentValue,
} from "../src/schema.js";
import type { ArgumentDefinitions } from "../src/types.js";

const definitions: ArgumentDefinitions = {
    action: {
        type: "enum",
        values: ["create", "delete"],
        required: true,
        positional: 0,
    },
    branchName: {
        type: "string",
        required: true,
        positional: 1,
    },
    dryRun: {
        type: "boolean",
        aliases: ["d"],
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

    void it("centralizes flag aliases and positional exclusion", () => {
        const lookup = createArgumentLookup(definitions);

        assert.equal(findArgumentName(lookup, "--dry-run"), "dryRun");
        assert.equal(findArgumentName(lookup, "-d"), "dryRun");
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
    });

    void it("applies defaults and derives display hints", () => {
        assert.deepEqual(applyArgumentDefaults(definitions, {}), { count: 1 });
        assert.equal(argumentValueHint(definitions.branchName!, "branchName"), "branch-name");
        assert.equal(argumentValueHint(definitions.action!, "action"), "create|delete");
    });
});
