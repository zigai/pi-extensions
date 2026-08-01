import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ARGUMENT_GROUP, type ArgumentDefinitions } from "../src/types.js";
import {
    assertCompiles,
    cloneAndFreezeDefinitions,
    compileTypedCommandDefinition,
} from "../src/compiler.js";
import { group } from "../src/arguments.js";

describe("typed command compiler", () => {
    it("clones and freezes the complete definition graph", () => {
        const aliases = ["t"];
        const examples = ["hello"];
        const multiDefault = ["api"];
        const listDefault = ["one"];
        const keyValueDefault = { MODE: "safe" };
        const enumValues = ["dev", "prod"] as const;
        const multiValues = ["api", "web"] as const;
        const renderValue = (): string => "custom";
        const handleInput = (): boolean => true;
        const definitions = {
            text: {
                type: "string",
                aliases,
                examples,
                pattern: /hello/giu,
                complete: () => [],
                completeAsync: async () => [],
                ui: {
                    widget: "custom",
                    rows: 2,
                    title: "Text",
                    readOnly: true,
                    hidden: false,
                    visibleWhen: true,
                    enabledWhen: true,
                    requiredWhen: false,
                    compute: () => "computed",
                    disabled: false,
                    section: "Basics",
                    advanced: true,
                    copyFrom: "other",
                    custom: { renderValue, handleInput },
                },
            },
            choice: {
                type: "enum",
                values: enumValues,
                optionDescriptions: { dev: "Development", prod: "Production" },
            },
            tags: {
                type: "multi-enum",
                values: multiValues,
                default: multiDefault,
            },
            items: {
                type: "string-list",
                default: listDefault,
            },
            environment: {
                type: "key-value",
                default: keyValueDefault,
            },
            database: group(
                {
                    host: { type: "string", default: "localhost" },
                },
                { title: "Database", description: "Database settings" },
            ),
        } satisfies ArgumentDefinitions;

        const cloned = cloneAndFreezeDefinitions(definitions);

        assert.notEqual(cloned, definitions);
        assert.notEqual(cloned.text, definitions.text);
        assert.notEqual(cloned.text.aliases, aliases);
        assert.notEqual(cloned.text.examples, examples);
        assert.notEqual(cloned.text.pattern, definitions.text.pattern);
        assert.notEqual(cloned.text.ui, definitions.text.ui);
        assert.notEqual(cloned.text.ui?.custom, definitions.text.ui?.custom);
        assert.notEqual(cloned.tags?.default, multiDefault);
        assert.notEqual(cloned.items?.default, listDefault);
        assert.notEqual(cloned.environment?.default, keyValueDefault);
        assert.notEqual(cloned.choice?.values, enumValues);
        assert.notEqual(cloned.choice?.optionDescriptions, definitions.choice.optionDescriptions);
        assert.notEqual(cloned.database, definitions.database);
        assert.notEqual(cloned.database?.args, definitions.database.args);
        assert.equal(cloned.database?.[ARGUMENT_GROUP], cloned.database?.args);

        assert.equal(Object.isFrozen(cloned), true);
        assert.equal(Object.isFrozen(cloned.text), true);
        assert.equal(Object.isFrozen(cloned.text.aliases), true);
        assert.equal(Object.isFrozen(cloned.text.examples), true);
        assert.equal(Object.isFrozen(cloned.text.pattern), true);
        assert.equal(Object.isFrozen(cloned.text.ui), true);
        assert.equal(Object.isFrozen(cloned.text.ui?.custom), true);
        assert.equal(Object.isFrozen(cloned.tags?.default), true);
        assert.equal(Object.isFrozen(cloned.items?.default), true);
        assert.equal(Object.isFrozen(cloned.environment?.default), true);
        assert.equal(Object.isFrozen(cloned.choice?.values), true);
        assert.equal(Object.isFrozen(cloned.choice?.optionDescriptions), true);
        assert.equal(Object.isFrozen(cloned.database), true);
        assert.equal(Object.isFrozen(cloned.database?.args), true);

        aliases.push("alias");
        examples.push("world");
        multiDefault.push("web");
        listDefault.push("two");
        keyValueDefault.MODE = "unsafe";

        assert.deepEqual(cloned.text.aliases, ["t"]);
        assert.deepEqual(cloned.text.examples, ["hello"]);
        assert.deepEqual(cloned.tags?.default, ["api"]);
        assert.deepEqual(cloned.items?.default, ["one"]);
        assert.deepEqual(cloned.environment?.default, { MODE: "safe" });
    });

    it("exposes immutable argument and flag metadata through read-only maps", () => {
        const compiled = assertCompiles({
            name: "deploy",
            description: "Deploy",
            args: {
                environment: { type: "enum", values: ["dev", "prod"] },
                dryRun: { type: "boolean", flag: "dry-run" },
            },
        });

        assert.equal(compiled.argumentByName.size, 2);
        assert.deepEqual([...compiled.argumentByName.keys()], ["environment", "dryRun"]);
        assert.deepEqual(
            [...compiled.argumentByName.values()].map((argument) => argument.key),
            ["environment", "dryRun"],
        );
        assert.equal(compiled.argumentByName.has("environment"), true);
        assert.equal(compiled.argumentByName.get("missing"), undefined);
        assert.deepEqual(
            [...compiled.argumentByName.entries()].map(([key]) => key),
            ["environment", "dryRun"],
        );

        const visited: string[] = [];
        compiled.argumentByName.forEach((argument, name, map) => {
            visited.push(`${name}:${argument.key}:${map === compiled.argumentByName}`);
        });
        assert.deepEqual(visited, ["environment:environment:true", "dryRun:dryRun:true"]);
        assert.deepEqual(
            [...compiled.argumentByName].map(([key, argument]) => `${key}:${argument.key}`),
            ["environment:environment", "dryRun:dryRun"],
        );

        assert.equal(compiled.flagToName.size, 2);
        assert.equal(compiled.flagToName.get("environment"), "environment");
        assert.equal(compiled.flagToName.get("dry-run"), "dryRun");
        assert.equal(compiled.flagToName.has("missing"), false);
        assert.deepEqual([...compiled.flagToName.keys()], ["environment", "dry-run"]);
        assert.deepEqual([...compiled.flagToName.values()], ["environment", "dryRun"]);
    });

    it("returns diagnostics from compilation and turns them into a startup error", () => {
        const result = compileTypedCommandDefinition({
            name: "invalid",
            description: "Invalid",
            args: { count: { type: "number", min: 10, max: 1 } },
        });

        assert.equal(result.ok, false);
        if (result.ok) {
            assert.fail("expected invalid definition diagnostics");
        }
        assert.match(result.diagnostics[0]?.message ?? "", /min must be less than or equal to max/);
        assert.throws(
            () =>
                assertCompiles({
                    name: "invalid",
                    description: "Invalid",
                    args: { count: { type: "number", min: 10, max: 1 } },
                }),
            /min must be less than or equal to max/,
        );
    });
});
