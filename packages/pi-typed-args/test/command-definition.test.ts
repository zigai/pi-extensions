import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { group } from "../src/arguments.ts";
import { assertCompiles } from "../src/compiler.ts";
import { defineTypedCommand } from "../src/command/definition.ts";
import { normalizeRegisteredCommand } from "../src/command/registered-command.ts";
import { getPiTypedCommandRegistry } from "../src/pi/registry.ts";
import { registerTypedCommand } from "../src/pi/register.ts";
import type { TypedCommandDefinition } from "../src/pi/command-types.ts";
import type { ArgumentDefinitions } from "../src/types.ts";
import { createTestExtensionApi } from "./pi-test-adapter.ts";

const noop = () => {};

describe("typed command definition compilation", () => {
    it("reuses only the exact immutable root grammar prepared within the operation", () => {
        const definition = {
            name: "prepared-root-test",
            description: "Prepared root",
            args: {
                database: group({ host: { type: "string", default: "localhost" } }),
                tags: { type: "multi-enum", values: ["api", "web"], default: ["api"] },
            },
            run: noop,
        } satisfies TypedCommandDefinition<ArgumentDefinitions>;
        const compiled = assertCompiles(definition);
        const normalized = normalizeRegisteredCommand(
            { ...definition, args: compiled.definitions },
            compiled,
        );

        assert.equal(normalized.compiled, compiled);
        assert.equal(normalized.args, compiled.args);
        assert.equal(Object.isFrozen(normalized.args), true);
        assert.equal(Object.isFrozen(compiled.definitions), true);
        assert.notEqual(compiled.definitions, definition.args);
        assert.notEqual(compiled.definitions.tags.default, definition.args.tags.default);

        // A prepared grammar must not suppress a fresh snapshot of a different input tree.
        definition.args.tags.default.push("web");
        const resnapshotted = normalizeRegisteredCommand(definition, compiled);
        assert.notEqual(resnapshotted.compiled, compiled);
        assert.deepEqual(resnapshotted.args.tags?.default, ["api", "web"]);
        assert.deepEqual(compiled.args.tags?.default, ["api"]);

        // Header changes must also retain the exact grammar/command metadata relationship.
        const renamed = normalizeRegisteredCommand(
            { ...definition, name: "renamed-root-test", args: compiled.definitions },
            compiled,
        );
        assert.notEqual(renamed.compiled, compiled);
        assert.equal(renamed.compiled.name, "renamed-root-test");
        const redescribed = normalizeRegisteredCommand(
            { ...definition, description: "Changed", args: compiled.definitions },
            compiled,
        );
        assert.equal(redescribed.compiled.description, "Changed");
    });

    it("preserves validation precedence for definition and registration", () => {
        const invalid = {
            name: "two words",
            description: "Invalid name and arguments",
            args: { count: { type: "number", min: 10, max: 1 } },
            run: noop,
        } satisfies TypedCommandDefinition<ArgumentDefinitions>;
        assert.throws(() => defineTypedCommand(invalid), /min must be less than or equal to max/);
        assert.throws(
            () => registerTypedCommand(createTestExtensionApi(), invalid),
            /Invalid command name/,
        );
        assert.throws(() => defineTypedCommand({ ...invalid, args: {} }), /Invalid command name/);
        assert.throws(
            () =>
                defineTypedCommand({
                    name: "missing-target-test",
                    description: "No handler",
                    args: {},
                }),
            /must define run or subcommands/,
        );
    });

    it("keeps independent frozen root snapshots and caller-owned branch metadata", () => {
        const branch = {
            description: "Before",
            args: { value: { type: "string" as const, default: "before" } },
            aliases: ["show"],
            run: noop,
        };
        const raw = {
            name: "mutable-branch-snapshot-test",
            description: "Mutable branch snapshot",
            args: { tags: { type: "string-list" as const, default: ["original"] } },
            subcommands: { inspect: branch },
        };
        const first = defineTypedCommand(raw);
        raw.args.tags.default.push("changed");
        const second = defineTypedCommand(raw);
        assert.notEqual(first, second);
        assert.notEqual(first.args, second.args);
        assert.deepEqual(first.args.tags.default, ["original"]);
        assert.deepEqual(second.args.tags.default, ["original", "changed"]);
        assert.equal(Object.isFrozen(first), true);
        assert.equal(Object.isFrozen(first.args.tags.default), true);
        assert.equal(first.subcommands, raw.subcommands);
        assert.equal(Object.isFrozen(first.subcommands), false);
        assert.equal(Object.isFrozen(branch.args), false);
        const original = first.parse("show");
        assert.equal(original.status, "success");
        if (original.status !== "success") assert.fail("expected original branch defaults");
        assert.deepEqual(original.value, { tags: ["original"], value: "before" });
        branch.args.value.default = "after";
        branch.description = "After";
        branch.aliases.push("view");
        const handle = registerTypedCommand(createTestExtensionApi(), first);
        try {
            assert.notEqual(handle.definition, first);
            assert.deepEqual(first.parse("show"), original);
            const result = handle.parse("view");
            assert.equal(result.status, "success");
            if (result.status !== "success") assert.fail("expected new branch defaults");
            assert.deepEqual(result.value, { tags: ["original"], value: "after" });
            const metadata = getPiTypedCommandRegistry().get(handle.invocationName);
            assert.equal(metadata?.subcommands?.inspect?.description, "After");
            assert.equal(Object.isFrozen(metadata?.subcommands?.inspect?.aliases), true);
            assert.equal(Object.isFrozen(branch.aliases), false);
        } finally {
            handle.dispose();
        }
    });

    it("takes a fresh handle snapshot after Pi and registry callbacks", () => {
        const raw = {
            name: "registration-snapshot-boundary-test",
            description: "Registration snapshot boundary",
            args: { value: { type: "string" as const, default: "before" } },
            subcommands: {
                inspect: {
                    description: "Before branch",
                    args: { branch: { type: "string" as const, default: "before" } },
                    run: noop,
                },
            },
            run: noop,
        };
        const registry = getPiTypedCommandRegistry();
        const stop = registry.onChanged(() => {
            raw.args.value.default = "after-listener";
            raw.subcommands.inspect.args.branch.default = "after-listener";
        });
        const handle = registerTypedCommand(
            createTestExtensionApi({
                registerCommand() {
                    raw.args.value.default = "after-pi";
                    raw.subcommands.inspect.args.branch.default = "after-pi";
                },
            }),
            raw,
        );
        stop();
        try {
            const metadata = registry.get(handle.invocationName);
            assert.equal(metadata?.args.value?.default, "before");
            assert.equal(metadata?.subcommands?.inspect?.args.branch?.default, "before");
            assert.equal(handle.definition.args.value.default, "after-listener");
            const parsed = handle.parse("inspect");
            assert.equal(parsed.status, "success");
            if (parsed.status !== "success") assert.fail("expected updated handle snapshot");
            assert.deepEqual(parsed.value, { value: "after-listener", branch: "after-listener" });
        } finally {
            stop();
            handle.dispose();
        }
    });
});
