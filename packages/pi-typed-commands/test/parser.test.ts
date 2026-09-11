import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import {
    getTypedArgumentCompletions as resolveTypedArgumentCompletions,
    getTypedAutocompleteSuggestions as resolveTypedAutocompleteSuggestions,
    getTypedFormValueCompletions,
    type CompletionCapabilities,
} from "../src/completions.js";
import {
    defineTypedCommand,
    formatCommandUsage,
    group,
    parseTypedCommandArgs,
    serializeTypedCommandArgs,
    toTypedParseResult,
} from "../src/index.js";
import { compileTypedCommandDefinition } from "../src/compiler.js";
import { createTypedCommandRegistry } from "../src/registry.js";
import { createPiCompletionCapabilities } from "../src/pi/completions.js";
import { formatHelperLineParts } from "../src/usage.js";
import type { ArgumentDefinition } from "../src/types.js";
import type { RegisteredTypedCommand } from "../src/pi/command-types.js";
import { createTestSignal } from "./pi-test-adapter.js";

const completionRegistry = createTypedCommandRegistry();

function completionCapabilities() {
    return createPiCompletionCapabilities(process.cwd(), completionRegistry);
}

function registerTypedCommandMetadata(command: RegisteredTypedCommand): string {
    return completionRegistry.register(command);
}

function withRegisteredCommand<T>(command: RegisteredTypedCommand, run: () => T): T {
    registerTypedCommandMetadata(command);
    try {
        return run();
    } finally {
        completionRegistry.unregister(command);
    }
}

async function withRegisteredCommandAsync<T>(
    command: RegisteredTypedCommand,
    run: () => Promise<T>,
): Promise<T> {
    registerTypedCommandMetadata(command);
    try {
        return await run();
    } finally {
        completionRegistry.unregister(command);
    }
}

async function getTypedArgumentCompletions(
    command: RegisteredTypedCommand,
    argumentPrefix: string,
    capabilities: CompletionCapabilities = completionCapabilities(),
) {
    return resolveTypedArgumentCompletions(command, argumentPrefix, capabilities);
}

type StringCompletionProvider = NonNullable<
    Extract<ArgumentDefinition, { readonly type: "string" }>["complete"]
>;

function malformedJavaScriptCompletionProvider(): StringCompletionProvider {
    const provider = () => [
        { value: 123 },
        { value: "feature", label: 456, description: "valid item" },
        { value: "quoted", replacement: '"quoted value"' },
    ];
    // SAFETY: This fixture deliberately simulates an untyped JavaScript extension returning
    // malformed provider items. The production completion boundary validates every item before use.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return provider as StringCompletionProvider;
}

function getTypedAutocompleteSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    capabilities: CompletionCapabilities = completionCapabilities(),
) {
    return resolveTypedAutocompleteSuggestions(lines, cursorLine, cursorCol, capabilities);
}

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
    formSymbols: {
        selectedCheckbox: "■",
        unselectedCheckbox: "□",
        selectedRadio: "●",
        unselectedRadio: "○",
    },
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
            position: 0,
            description: "Branch action",
        },
        name: {
            type: "string",
            required: true,
            position: 1,
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

describe("parseTypedCommandArgs", () => {
    it("rejects raw parse details paired with a different compiled grammar", () => {
        const first = compileTypedCommandDefinition({
            name: "first-proof",
            description: "First proof",
            args: { count: { type: "number", required: true } },
        });
        const second = compileTypedCommandDefinition({
            name: "second-proof",
            description: "Second proof",
            args: { branch: { type: "string", required: true } },
        });
        if (!first.ok || !second.ok) {
            assert.fail("expected both proof grammars to compile");
        }

        const parsed = parseTypedCommandArgs(
            { args: first.command.args, compiled: first.command },
            "--count 2",
        );

        assert.throws(
            () => toTypedParseResult(second.command, parsed),
            /different compiled grammar/,
        );
    });

    it("revalidates grouped leaves before returning mapped typed values", () => {
        const compiled = compileTypedCommandDefinition({
            name: "grouped-proof",
            description: "Grouped proof",
            args: {
                database: group({ port: { type: "number", required: true } }),
            },
        });
        if (!compiled.ok) {
            assert.fail("expected grouped proof grammar to compile");
        }

        const parsed = parseTypedCommandArgs(
            { args: compiled.command.args, compiled: compiled.command },
            "--database-port 5432",
        );
        const tampered = {
            ...parsed,
            grammar: compiled.command,
            values: { "database.port": "not-a-number" },
        };

        const result = toTypedParseResult(compiled.command, tampered);
        assert.equal(result.status, "error");

        if (result.status === "error") {
            assert.equal(result.issues[0]?.kind, "invalid-value");
            assert.deepEqual(result.partial, { database: { port: undefined } });
        }
    });

    it("reconstructs defaulted leaves before returning typed success", () => {
        const compiled = compileTypedCommandDefinition({
            name: "default-presence-proof",
            description: "Default presence proof",
            args: { ref: { type: "string", default: "main" } },
        });
        if (!compiled.ok) {
            assert.fail("expected default-presence grammar to compile");
        }

        const parsed = parseTypedCommandArgs(
            { args: compiled.command.args, compiled: compiled.command },
            "",
        );
        const withoutDefault = {
            ...parsed,
            grammar: compiled.command,
            values: {},
            sources: new Map(),
        };

        const result = toTypedParseResult(compiled.command, withoutDefault);
        assert.equal(result.status, "success");

        if (result.status === "success") {
            assert.deepEqual(result.value, { ref: "main" });
            assert.equal(result.sources.get("ref"), "default");
        }
    });

    it("parses named enum, string, boolean, and number args", () => {
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

    it("reuses compiled RegExp constraints without mutating caller state or throwing", () => {
        const callerPattern = /^[a-z]+$/g;
        const regexCommand = defineTypedCommand({
            name: "regex-test",
            description: "Regex test",
            args: {
                name: { type: "string", pattern: callerPattern, required: true },
            },
            run() {},
        });

        assert.doesNotThrow(() => regexCommand.parse("--name demo"));
        assert.equal(regexCommand.parse("--name demo").status, "success");
        assert.equal(regexCommand.parse("--name INVALID").status, "error");
        assert.equal(callerPattern.lastIndex, 0);
    });

    it("applies defaults and reports missing required args", () => {
        const parsed = parseTypedCommandArgs(command, "");
        assert.equal(parsed.values.ref, "main");
        assert.equal(parsed.issues.length, 1);
        assert.equal(parsed.issues[0]?.kind, "missing-required");
        assert.equal(parsed.issues[0]?.name, "env");
    });

    it("supports no-boolean flags", () => {
        const parsed = parseTypedCommandArgs(command, "--env dev --no-dry-run");
        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.dryRun, false);
    });

    it("rejects explicitly empty required collections", () => {
        const requiredCollections: RegisteredTypedCommand = {
            ...command,
            args: {
                tags: { type: "multi-enum", values: ["api"], required: true },
                item: { type: "string-list", required: true },
                setting: { type: "key-value", required: true },
            },
        };

        const parsed = parseTypedCommandArgs(
            requiredCollections,
            '--tags="" --item="" --setting=""',
        );

        assert.deepEqual(
            parsed.issues.map((issue) => [issue.name, issue.message]),
            [
                ["tags", "--tags is required"],
                ["item", "--item is required"],
                ["setting", "--setting is required"],
            ],
        );
    });

    it("parses multi-enum comma lists and repeated flags", () => {
        const parsed = parseTypedCommandArgs(command, "--env dev --tags api,web --tags worker");
        assert.deepEqual(parsed.issues, []);
        assert.deepEqual(parsed.values.tags, ["api", "web", "worker"]);
    });

    it("deduplicates one multi-enum occurrence under non-append policies", () => {
        const nonAppending: RegisteredTypedCommand = {
            ...command,
            args: {
                tags: {
                    type: "multi-enum",
                    values: ["api", "web"],
                    occurrence: "last",
                },
            },
        };

        const parsed = parseTypedCommandArgs(nonAppending, "--tags api,api");
        assert.deepEqual(parsed.issues, []);
        assert.deepEqual(parsed.values.tags, ["api"]);
    });

    it("accepts negative numeric flag values", () => {
        const parsed = parseTypedCommandArgs(command, "--env dev --count -1");
        assert.equal(parsed.values.count, undefined);
        assert.equal(parsed.issues[0]?.message, "--count must be at least 1");
    });

    it("preserves negative zero through number serialization", () => {
        const numberCommand: RegisteredTypedCommand = {
            ...command,
            args: { count: { type: "number" } },
        };

        const raw = serializeTypedCommandArgs(numberCommand, { count: -0 });
        const parsed = parseTypedCommandArgs(numberCommand, raw);
        assert.equal(raw, "--count=-0");
        assert.equal(Object.is(parsed.values.count, -0), true);

        const positionalCommand: RegisteredTypedCommand = {
            ...numberCommand,
            args: { count: { type: "number", position: 0 } },
        };
        const positionalRaw = serializeTypedCommandArgs(positionalCommand, { count: -0 });
        const positionalParsed = parseTypedCommandArgs(positionalCommand, positionalRaw);
        assert.equal(positionalRaw, '"-0"');
        assert.equal(Object.is(positionalParsed.values.count, -0), true);

        const defaultCommand: RegisteredTypedCommand = {
            ...numberCommand,
            args: { count: { type: "number", default: -0 } },
        };
        assert.match(formatCommandUsage(defaultCommand), /=-0/);
    });

    it("treats Object prototype spellings as ordinary argument names", () => {
        const inheritedNameCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                toString: { type: "string" as const, default: "safe" },
                valueOf: { type: "string" as const },
            },
        };

        const parsed = parseTypedCommandArgs(inheritedNameCommand, "");
        assert.deepEqual(parsed.issues, []);
        assert.equal(Object.getPrototypeOf(parsed.values), Object.prototype);
        assert.equal(Object.hasOwn(parsed.values, "toString"), true);
        assert.equal(Object.hasOwn(parsed.values, "valueOf"), true);
        assert.deepEqual(Object.getOwnPropertyDescriptor(parsed.values, "toString"), {
            configurable: true,
            enumerable: true,
            value: "safe",
            writable: true,
        });
        assert.deepEqual(Object.getOwnPropertyDescriptor(parsed.values, "valueOf"), {
            configurable: true,
            enumerable: false,
            value: undefined,
            writable: true,
        });
        assert.deepEqual(Object.keys(parsed.values), ["toString"]);
        assert.deepEqual(Object.entries(parsed.values), [["toString", "safe"]]);
        assert.equal(serializeTypedCommandArgs(inheritedNameCommand, {}), "");
    });

    it("supports -- as an end-of-options marker", () => {
        const parsed = parseTypedCommandArgs(branchCommand, "create -- --literal-branch");
        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.action, "create");
        assert.equal(parsed.values.name, "--literal-branch");
    });

    it("does not treat --help after -- as help mode", () => {
        const parsed = parseTypedCommandArgs(branchCommand, "create -- --help");
        assert.equal(parsed.mode, "run");
        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.name, "--help");
    });

    it("parses negative positional numbers when a number positional is expected", () => {
        const numericCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                offset: {
                    type: "number",
                    position: 0,
                    min: -5,
                },
            },
        };
        const parsed = parseTypedCommandArgs(numericCommand, "-1");
        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.offset, -1);
    });

    it("parses positional args before named flags", () => {
        const parsed = parseTypedCommandArgs(branchCommand, "create feature/foo --base main");
        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.action, "create");
        assert.equal(parsed.values.name, "feature/foo");
        assert.equal(parsed.values.base, "main");
    });

    it("supports the explicit position field for positional args", () => {
        const positionedCommand: RegisteredTypedCommand = {
            ...branchCommand,
            args: {
                name: { type: "string", required: true, position: 1 },
                action: {
                    type: "enum",
                    values: ["create", "delete"],
                    required: true,
                    position: 0,
                },
            },
        };

        const parsed = parseTypedCommandArgs(positionedCommand, "create feature/foo");
        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.action, "create");
        assert.equal(parsed.values.name, "feature/foo");
    });

    it("consumes rest positional string arguments", () => {
        const restCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                title: { type: "string", required: true, position: 0 },
                body: { type: "string", position: 1, rest: true },
            },
        };

        const parsed = parseTypedCommandArgs(restCommand, "note this is the body --literal");
        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.title, "note");
        assert.equal(parsed.values.body, "this is the body --literal");
    });

    it("parses leading flags before a rest positional and preserves later dash-prefixed text", () => {
        const restCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                task: { type: "string", position: 0, rest: true },
                raw: { type: "boolean", aliases: ["r"] },
            },
        };

        const parsed = parseTypedCommandArgs(restCommand, "-r Build --literal output");
        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.raw, true);
        assert.equal(parsed.values.task, "Build --literal output");
    });

    it("serializes named flags before a rest positional for a parseable round trip", () => {
        const restCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                task: { type: "string", position: 0, rest: true },
                raw: { type: "boolean", aliases: ["r"] },
            },
        };

        const serialized = serializeTypedCommandArgs(restCommand, {
            task: "Build and verify",
            raw: true,
        });
        const parsed = parseTypedCommandArgs(restCommand, serialized);
        assert.equal(serialized, '--raw "Build and verify"');
        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.raw, true);
        assert.equal(parsed.values.task, "Build and verify");
    });

    it("keeps form-only arguments out of CLI parsing, serialization, and usage", () => {
        const formOnlyCommand: RegisteredTypedCommand = {
            ...command,
            name: "goal",
            args: {
                task: { type: "string", position: 0, rest: true },
                maximumTimeMinutes: {
                    type: "number",
                    integer: true,
                    min: 1,
                    formOnly: true,
                },
            },
        };

        const parsed = parseTypedCommandArgs(
            formOnlyCommand,
            "--maximum-time-minutes 15 Build and verify",
        );
        const serialized = serializeTypedCommandArgs(formOnlyCommand, {
            task: "Build and verify",
            maximumTimeMinutes: 15,
        });
        const usage = formatCommandUsage(formOnlyCommand);
        assert.equal(parsed.issues[0]?.kind, "unknown-argument");
        assert.equal(serialized, '"Build and verify"');
        assert.doesNotMatch(usage, /maximum-time-minutes/);
    });

    it("recognizes --help and -h", () => {
        const longHelp = parseTypedCommandArgs(command, "--help");
        const shortHelp = parseTypedCommandArgs(command, "-h");
        assert.equal(longHelp.mode, "help");
        assert.equal(shortHelp.mode, "help");
    });

    it("parses quoted and escaped values", () => {
        const parsed = parseTypedCommandArgs(
            command,
            '--env dev --ref "feature with spaces" --tags api\\,web',
        );

        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.ref, "feature with spaces");
        assert.deepEqual(parsed.values.tags, ["api", "web"]);
    });

    it("reports unterminated quotes without discarding parsed values", () => {
        const parsed = parseTypedCommandArgs(command, '--env dev --ref "feature');
        assert.equal(parsed.values.env, "dev");
        assert.equal(parsed.values.ref, "feature");
        assert.equal(parsed.issues[0]?.kind, "unterminated-quote");
    });

    it("parses inline flag values and explicit booleans", () => {
        const parsed = parseTypedCommandArgs(command, "--env=prod --dry-run=false");
        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.env, "prod");
        assert.equal(parsed.values.dryRun, false);
    });

    it("rejects empty inline number values instead of coercing them to zero", () => {
        const parsed = parseTypedCommandArgs(command, "--env dev --count=");
        assert.equal(parsed.values.count, undefined);
        assert.deepEqual(
            parsed.issues.map((issue) => [issue.kind, issue.name, issue.message]),
            [["invalid-value", "count", "--count expects a number"]],
        );
    });

    it("clones multi-enum defaults for each parse result", () => {
        const defaultedCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                tags: {
                    type: "multi-enum",
                    values: ["api", "web"],
                    default: ["api"],
                },
            },
        };

        const first = parseTypedCommandArgs(defaultedCommand, "");
        assert.ok(Array.isArray(first.values.tags));
        first.values.tags.push("web");

        const second = parseTypedCommandArgs(defaultedCommand, "");
        assert.deepEqual(second.values.tags, ["api"]);
        assert.deepEqual(defaultedCommand.args.tags?.default, ["api"]);
    });

    it("reports unknown flags, missing values, and invalid no-flags", () => {
        const parsed = parseTypedCommandArgs(command, "--unknown --ref --no-ref");

        assert.deepEqual(
            parsed.issues.map((issue) => issue.kind),
            ["unknown-argument", "missing-value", "invalid-value", "missing-required"],
        );
    });

    it("preserves Windows paths and empty quoted strings", () => {
        const pathCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                path: { type: "string", required: true, position: 0 },
                label: { type: "string", position: 1 },
            },
        };

        const windowsPath = parseTypedCommandArgs(pathCommand, String.raw`C:\Users\me\file.txt ""`);
        assert.deepEqual(windowsPath.issues, []);
        assert.equal(windowsPath.values.path, String.raw`C:\Users\me\file.txt`);
        assert.equal(windowsPath.values.label, "");
    });

    it("treats quoted help as a literal value", () => {
        const pathCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                path: { type: "string", required: true, position: 0 },
            },
        };

        const parsed = parseTypedCommandArgs(pathCommand, '"--help"');
        assert.equal(parsed.mode, "run");
        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.path, "--help");
    });

    it("marks invalid provided values without duplicating required diagnostics", () => {
        const requiredNumberCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                count: { type: "number", required: true },
                defaulted: { type: "number", default: 1 },
            },
        };

        const parsed = parseTypedCommandArgs(
            requiredNumberCommand,
            "--count nope --defaulted nope",
        );

        assert.equal(parsed.provided.has("count"), true);
        assert.equal(parsed.values.defaulted, undefined);
        assert.deepEqual(
            parsed.issues.map((issue) => [issue.kind, issue.name, issue.message]),
            [
                ["invalid-value", "count", "--count expects a number"],
                ["invalid-value", "defaulted", "--defaulted expects a number"],
            ],
        );
    });

    it("rejects inline values on no-boolean flags", () => {
        const parsed = parseTypedCommandArgs(command, "--env dev --no-dry-run=true");
        assert.equal(parsed.values.dryRun, undefined);
        assert.deepEqual(
            parsed.issues.map((issue) => [issue.kind, issue.name]),
            [["invalid-value", "dryRun"]],
        );
    });

    it("supports explicit flag names and aliases", () => {
        const databaseCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                databaseHost: {
                    type: "string",
                    flag: "db-host",
                    aliases: ["database-host"],
                    required: true,
                },
            },
        };

        const parsed = parseTypedCommandArgs(databaseCommand, "--database-host localhost");
        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.databaseHost, "localhost");
    });

    it("runs command-level cross-field validation", () => {
        const rangeCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                start: { type: "number", required: true },
                end: { type: "number", required: true },
            },
            refine(args) {
                if (
                    typeof args.start === "number" &&
                    typeof args.end === "number" &&
                    args.start > args.end
                ) {
                    return [{ message: "start must not exceed end", path: ["start"] }];
                }

                return [];
            },
        };

        const parsed = parseTypedCommandArgs(rangeCommand, "--start 10 --end 5");

        assert.deepEqual(
            parsed.issues.map((issue) => [issue.kind, issue.name, issue.message]),
            [["invalid-value", "start", "start must not exceed end"]],
        );
    });

    it("makes duplicate occurrence behavior explicit", () => {
        const defaultDuplicate = parseTypedCommandArgs(command, "--env dev --env prod");
        const lastWinsCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                env: { type: "enum", values: ["dev", "prod"], occurrence: "last" },
            },
        };
        const lastWins = parseTypedCommandArgs(lastWinsCommand, "--env dev --env prod");
        assert.equal(defaultDuplicate.issues[0]?.kind, "duplicate-argument");
        assert.deepEqual(lastWins.issues, []);
        assert.equal(lastWins.values.env, "prod");
    });

    it("serializes values into parseable command arguments", () => {
        const pathCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                env: { type: "enum", values: ["dev", "prod"], required: true, position: 0 },
                ref: { type: "string" },
                dryRun: { type: "boolean" },
                tags: { type: "multi-enum", values: ["api", "web"] },
            },
        };

        const raw = serializeTypedCommandArgs(pathCommand, {
            env: "prod",
            ref: "feature with spaces",
            dryRun: false,
            tags: ["api", "web"],
        });
        const parsed = parseTypedCommandArgs(pathCommand, raw);
        assert.equal(raw, 'prod --ref="feature with spaces" --no-dry-run --tags=api,web');
        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.env, "prod");
        assert.equal(parsed.values.ref, "feature with spaces");
        assert.equal(parsed.values.dryRun, false);
        assert.deepEqual(parsed.values.tags, ["api", "web"]);
    });

    it("round-trips duplicate string-list items without silently changing them", () => {
        const listCommand: RegisteredTypedCommand = {
            ...command,
            args: { item: { type: "string-list" } },
        };

        const raw = serializeTypedCommandArgs(listCommand, { item: ["alpha", "alpha", "beta"] });
        const parsed = parseTypedCommandArgs(listCommand, raw);
        assert.deepEqual(parsed.issues, []);
        assert.deepEqual(parsed.values.item, ["alpha", "alpha", "beta"]);
    });

    it("preserves prototype-like key-value keys as ordinary entries", () => {
        const keyValueCommand: RegisteredTypedCommand = {
            ...command,
            args: { setting: { type: "key-value" } },
        };
        const setting = Object.fromEntries([
            ["__proto__", "safe"],
            ["constructor", "value"],
        ]);

        const raw = serializeTypedCommandArgs(keyValueCommand, { setting });
        const parsed = parseTypedCommandArgs(keyValueCommand, raw);
        assert.deepEqual(parsed.issues, []);
        const parsedSetting = parsed.values.setting;
        if (typeof parsedSetting !== "object" || parsedSetting === null) {
            assert.fail("expected parsed key-value entries");
        }

        assert.equal(Object.hasOwn(parsedSetting, "__proto__"), true);
        assert.deepEqual(parsedSetting, setting);
    });

    it("rejects collection values that the CLI representation cannot preserve", () => {
        const collectionCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                item: { type: "string-list" },
                setting: { type: "key-value" },
            },
        };

        assert.throws(
            () => serializeTypedCommandArgs(collectionCommand, { item: ["alpha,beta"] }),
            /may not contain commas/,
        );
        assert.throws(
            () => serializeTypedCommandArgs(collectionCommand, { item: [" alpha"] }),
            /may not start or end with whitespace/,
        );
        assert.throws(
            () => serializeTypedCommandArgs(collectionCommand, { setting: { "a=b": "value" } }),
            /keys may not contain commas or equals signs/,
        );
        assert.throws(
            () => serializeTypedCommandArgs(collectionCommand, { setting: { key: "a,b" } }),
            /values may not contain commas/,
        );
    });

    it("omits sensitive positional strings from serialization", () => {
        const sensitivePositional: RegisteredTypedCommand = {
            ...command,
            args: {
                token: { type: "string", position: 0, sensitive: true },
                verbose: { type: "boolean" },
            },
        };

        assert.equal(
            serializeTypedCommandArgs(sensitivePositional, {
                token: "private",
                verbose: true,
            }),
            "--verbose",
        );
    });

    it("serializes grouped values through the directly exported core helper", () => {
        const compiled = compileTypedCommandDefinition({
            name: "grouped-serialization-proof",
            description: "Grouped serialization proof",
            args: {
                database: group({
                    host: { type: "string", required: true },
                    port: { type: "number", integer: true },
                }),
            },
        });
        if (!compiled.ok) {
            assert.fail("expected grouped serialization grammar to compile");
        }

        const groupedCommand = {
            args: compiled.command.args,
            compiled: compiled.command,
        };

        const raw = serializeTypedCommandArgs(groupedCommand, {
            database: { host: "localhost", port: 5432 },
        });
        const parsed = parseTypedCommandArgs(groupedCommand, raw);
        const typed = toTypedParseResult(compiled.command, parsed);
        assert.equal(raw, "--database-host=localhost --database-port=5432");
        assert.equal(typed.status, "success");

        if (typed.status === "success") {
            assert.deepEqual(typed.value, {
                database: { host: "localhost", port: 5432 },
            });
        }
    });
});

describe("formatCommandUsage", () => {
    it("renders positional args before flags", () => {
        assert.equal(
            formatCommandUsage(branchCommand),
            "/branch action:create | delete | rename name [--base=branch] [--checkout]",
        );
    });

    it("can render explicit types", () => {
        assert.equal(
            formatCommandUsage(branchCommand, { showTypes: true }),
            "/branch action:create | delete | rename name:string [--base=string] [--checkout]",
        );
    });

    it("places the required subcommand before shared flags in text and styled parts", () => {
        const root: RegisteredTypedCommand = {
            ...command,
            name: "workspace",
            args: { verbose: { type: "boolean" } },
            hasRootHandler: false,
            subcommands: { create: branchCommand },
        };

        assert.equal(formatCommandUsage(root), "/workspace <subcommand> [--verbose]");
        assert.equal(
            formatHelperLineParts(root)
                .map((part) => part.text)
                .join(""),
            "usage: /workspace <subcommand> [--verbose]",
        );
    });
});

describe("getTypedAutocompleteSuggestions", () => {
    it("reuses completion providers for expanded form fields", async () => {
        const definition: ArgumentDefinition = {
            type: "string",
            complete(query, context) {
                assert.equal(context.values.environment, "prod");
                return [
                    {
                        value: `${query}-result`,
                        label: "Resolved value",
                        description: "Completion-backed form option",
                    },
                ];
            },
        };

        const items = await getTypedFormValueCompletions(
            definition,
            "fea",
            { values: { environment: "prod" }, provided: new Set(["environment"]) },
            completionCapabilities(),
        );

        assert.deepEqual(items, [
            {
                value: "fea-result",
                label: "Resolved value",
                description: "Completion-backed form option",
            },
        ]);
    });

    it("keeps independently composed command registries isolated", () => {
        const left = createTypedCommandRegistry();
        const right = createTypedCommandRegistry();

        left.register(command);
        assert.equal(left.get(command.name)?.name, command.name);
        assert.equal(right.get(command.name), undefined);
        assert.deepEqual(right.list(), []);
    });

    it("replaces an existing registration when an explicit identity is reused", () => {
        const registry = createTypedCommandRegistry();
        const id = Symbol("shared-registration");
        const first: RegisteredTypedCommand = { ...command, name: "first-registration" };
        const second: RegisteredTypedCommand = { ...command, name: "second-registration" };

        registry.register(first, { id });
        registry.register(second, { id });
        assert.equal(registry.get("first-registration"), undefined);
        assert.equal(registry.get("second-registration")?.name, "second-registration");
        assert.deepEqual(
            registry.list().map((item) => item.name),
            ["second-registration"],
        );
    });

    it("removes superseded explicit invocation records", () => {
        const registry = createTypedCommandRegistry();
        const first: RegisteredTypedCommand = { ...command, name: "first-explicit" };
        const second: RegisteredTypedCommand = { ...command, name: "second-explicit" };
        registry.register(first, { invocationName: "shared-explicit" });
        registry.register(second, { invocationName: "shared-explicit" });
        let changes = 0;
        const unsubscribe = registry.onChanged(() => {
            changes += 1;
        });

        registry.unregister(first);

        unsubscribe();
        assert.equal(changes, 0);
        assert.equal(registry.get("shared-explicit")?.name, "second-explicit");
    });

    it("publishes one atomic registry change when replacing skills", () => {
        const registry = createTypedCommandRegistry();
        const snapshots: string[][] = [];
        const unsubscribe = registry.onChanged(() => {
            snapshots.push(registry.list().map((item) => item.name));
        });
        const first: RegisteredTypedCommand = {
            ...command,
            name: "first-skill",
            source: "skill",
        };
        const second: RegisteredTypedCommand = {
            ...command,
            name: "second-skill",
            source: "skill",
        };

        try {
            registry.replaceSkills([first, second]);
        } finally {
            unsubscribe();
        }

        assert.deepEqual(snapshots, [["first-skill", "second-skill"]]);
    });

    it("keeps extension metadata visible across colliding skill refreshes", () => {
        const registry = createTypedCommandRegistry();
        const extensionCommand: RegisteredTypedCommand = {
            ...command,
            name: "shared-name",
            source: "extension",
        };
        const skillCommand: RegisteredTypedCommand = {
            ...command,
            name: "shared-name",
            source: "skill",
        };

        registry.register(extensionCommand);
        registry.replaceSkills([skillCommand]);
        assert.equal(registry.get("shared-name")?.source, "extension");
        assert.equal(registry.get("shared-name:1")?.source, "skill");
        registry.replaceSkills([]);
        assert.equal(registry.get("shared-name")?.source, "extension");
        assert.equal(registry.get("shared-name:1"), undefined);
    });

    it("does not start async providers from synchronous editor completion", async () => {
        let calls = 0;
        const asyncCommand: RegisteredTypedCommand = {
            ...command,
            name: "async-editor-proof",
            args: {
                ref: {
                    type: "string",
                    async completeAsync() {
                        calls += 1;
                        return [{ value: "feature" }];
                    },
                },
            },
        };

        await withRegisteredCommandAsync(asyncCommand, async () => {
            const line = "/async-editor-proof --ref f";
            const editor = getTypedAutocompleteSuggestions([line], 0, line.length);
            assert.equal(editor, undefined);
            assert.equal(calls, 0);
            await getTypedArgumentCompletions(asyncCommand, "--ref f");
            assert.equal(calls, 1);
        });
    });

    it("has Pi observe a rejected promise returned by a malformed sync provider", async () => {
        const rejection = new Error("malformed sync provider rejected");
        const ref = { type: "string" as const };
        assert.equal(
            Reflect.defineProperty(ref, "complete", {
                value: async () => Promise.reject(rejection),
            }),
            true,
        );
        const malformedCommand: RegisteredTypedCommand = {
            ...command,
            name: "rejected-sync-completion",
            args: { ref },
        };
        const unhandledRejections: unknown[] = [];
        const recordUnhandledRejection = (cause: unknown): void => {
            unhandledRejections.push(cause);
        };

        process.on("unhandledRejection", recordUnhandledRejection);
        try {
            withRegisteredCommand(malformedCommand, () => {
                const line = "/rejected-sync-completion --ref f";
                assert.equal(getTypedAutocompleteSuggestions([line], 0, line.length), undefined);
            });
            await new Promise<void>((resolve) => {
                setImmediate(resolve);
            });
            assert.deepEqual(unhandledRejections, []);
        } finally {
            process.removeListener("unhandledRejection", recordUnhandledRejection);
        }
    });

    it("transfers a rejected thenable without starting completeAsync from sync completion", async () => {
        const rejection = new Error("malformed thenable rejected");
        const observedRejections: unknown[] = [];
        const observedTasks: Promise<void>[] = [];
        let asyncCalls = 0;
        const ref = {
            type: "string" as const,
            async completeAsync() {
                asyncCalls += 1;
                return [{ value: "feature" }];
            },
        };
        assert.equal(
            Reflect.defineProperty(ref, "complete", {
                value: () => ({
                    // oxlint-disable-next-line unicorn/no-thenable -- This fixture deliberately simulates a malformed JavaScript provider returning a thenable.
                    then(_resolve: (value: unknown) => void, reject: (cause: unknown) => void) {
                        reject(rejection);
                    },
                }),
            }),
            true,
        );
        const malformedCommand: RegisteredTypedCommand = {
            ...command,
            name: "thenable-sync-completion",
            args: { ref },
        };
        const capabilities: CompletionCapabilities = {
            ...completionCapabilities(),
            completionTasks: {
                own(task) {
                    observedTasks.push(
                        task.then(
                            () => undefined,
                            (cause: unknown) => {
                                observedRejections.push(cause);
                            },
                        ),
                    );
                },
            },
        };

        withRegisteredCommand(malformedCommand, () => {
            const line = "/thenable-sync-completion --ref f";
            assert.equal(
                getTypedAutocompleteSuggestions([line], 0, line.length, capabilities),
                undefined,
            );
        });

        assert.equal(asyncCalls, 0);
        assert.equal(observedTasks.length, 1);
        await Promise.all(observedTasks);
        assert.deepEqual(observedRejections, [rejection]);

        const suggestions = await getTypedArgumentCompletions(
            malformedCommand,
            "--ref f",
            capabilities,
        );
        assert.equal(asyncCalls, 1);
        assert.deepEqual(
            suggestions?.map((item) => item.value),
            ["--ref feature"],
        );
    });

    it("does not offer slash-command completions inside trailing body lines", () => {
        withRegisteredCommand(command, () => {
            const bodyLine = "/deploy --e";
            const suggestions = getTypedAutocompleteSuggestions(
                ["/deploy --env dev", bodyLine],
                1,
                bodyLine.length,
            );

            assert.equal(suggestions, undefined);
        });
    });

    it("suggests flags for typed commands", () => {
        withRegisteredCommand(command, () => {
            const suggestions = getTypedAutocompleteSuggestions(["/deploy --e"], 0, 11);
            assert.equal(suggestions?.prefix, "--e");
            assert.deepEqual(
                suggestions?.items.map((item) => item.label),
                ["--env"],
            );
        });
    });

    it("completes inline enum values", () => {
        withRegisteredCommand(command, () => {
            const suggestions = getTypedAutocompleteSuggestions(["/deploy --env=d"], 0, 15);
            assert.equal(suggestions?.prefix, "--env=d");
            assert.deepEqual(
                suggestions?.items.map((item) => item.value),
                ["--env=dev"],
            );
        });
    });

    it("completes values through Pi's command completion entry point", async () => {
        const suggestions = await getTypedArgumentCompletions(command, "--count 2 --env d");
        const afterTabWhitespace = await getTypedArgumentCompletions(command, "--env\t");

        assert.deepEqual(
            suggestions?.map((item) => item.value),
            ["--count 2 --env dev"],
        );
        assert.deepEqual(
            afterTabWhitespace?.map((item) => item.value),
            ["--env\tdev", "--env\tstaging", "--env\tprod"],
        );
    });

    it("preserves a selected subcommand in Pi command-level completion values", async () => {
        const root: RegisteredTypedCommand = {
            ...command,
            args: { global: { type: "boolean" } },
            hasRootHandler: false,
            subcommands: {
                run: {
                    ...command,
                    name: "deploy run",
                    args: { env: { type: "enum", values: ["dev", "prod"] } },
                },
            },
        };

        const suggestions = await getTypedArgumentCompletions(root, "run --env d");
        const quotedSubcommand = await getTypedArgumentCompletions(root, '"run" --env d');
        const rootFlag = await getTypedArgumentCompletions(root, "--g");

        assert.deepEqual(
            suggestions?.map((item) => item.value),
            ["run --env dev"],
        );
        assert.deepEqual(quotedSubcommand, []);
        assert.deepEqual(rootFlag, []);
    });

    it("quotes completed values when insertion would need shell quoting", async () => {
        const refCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                ref: {
                    type: "string",
                    complete: (query) =>
                        ["feature branch", "-dash"]
                            .filter((value) => value.startsWith(query))
                            .map((value) => ({ value })),
                },
            },
        };

        const spaced = await getTypedArgumentCompletions(refCommand, "--ref feature");
        const dashed = await getTypedArgumentCompletions(refCommand, "--ref -");

        assert.deepEqual(
            spaced?.map((item) => item.value),
            ['--ref "feature branch"'],
        );
        assert.deepEqual(
            dashed?.map((item) => item.value),
            ['--ref "-dash"'],
        );
    });

    it("honors provider-supplied replacement text", async () => {
        const refCommand: RegisteredTypedCommand = {
            ...command,
            name: "replacement-demo",
            args: {
                ref: {
                    type: "string",
                    complete: () => [
                        {
                            value: "feature branch",
                            replacement: '"provider-selected value"',
                            replaceRange: { start: 6, end: 13 },
                        },
                    ],
                },
            },
        };

        const suggestions = await getTypedArgumentCompletions(refCommand, "--ref feature");

        assert.deepEqual(suggestions, [
            {
                value: '--ref "provider-selected value"',
                label: "feature branch",
                replaceRange: { start: 6, end: 13 },
                replacementReady: true,
            },
        ]);

        withRegisteredCommand(refCommand, () => {
            const line = "/replacement-demo --ref feature";
            const editorSuggestions = getTypedAutocompleteSuggestions([line], 0, line.length);
            assert.equal(editorSuggestions?.prefix, "feature");
            assert.deepEqual(
                editorSuggestions?.items.map((item) => ({
                    value: item.value,
                    replaceRange: item.replaceRange,
                })),
                [
                    {
                        value: '"provider-selected value"',
                        replaceRange: { start: 6, end: 13 },
                    },
                ],
            );
        });
    });

    it("completes positional values", async () => {
        await withRegisteredCommandAsync(branchCommand, async () => {
            const directSuggestions = await getTypedArgumentCompletions(branchCommand, "c");
            const editorSuggestions = getTypedAutocompleteSuggestions(["/branch d"], 0, 9);

            assert.deepEqual(
                directSuggestions?.map((item) => item.value),
                ["create"],
            );
            assert.deepEqual(
                editorSuggestions?.items.map((item) => item.value),
                ["delete"],
            );
        });
    });

    it("stops completing flags after the end-of-options marker", async () => {
        await withRegisteredCommandAsync(command, async () => {
            assert.equal(await getTypedArgumentCompletions(command, "-- --e"), null);
            assert.equal(getTypedAutocompleteSuggestions(["/deploy -- --e"], 0, 14), undefined);
        });
    });

    it("supports async value completion providers", async () => {
        const asyncCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                ref: {
                    type: "string",
                    completeAsync: async (query) =>
                        ["main", "feature/login"]
                            .filter((value) => value.startsWith(query))
                            .map((value) => ({ value })),
                },
            },
        };

        const suggestions = await getTypedArgumentCompletions(asyncCommand, "--ref f");

        assert.deepEqual(
            suggestions?.map((item) => item.value),
            ["--ref feature/login"],
        );
    });

    it("contains invalid and throwing completion providers", async () => {
        const throwingCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                ref: {
                    type: "string",
                    complete() {
                        throw new Error("boom");
                    },
                },
            },
        };
        const invalidCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                ref: {
                    type: "string",
                    complete: malformedJavaScriptCompletionProvider(),
                },
            },
        };

        assert.equal(await getTypedArgumentCompletions(throwingCommand, "--ref f"), null);
        const suggestions = await getTypedArgumentCompletions(invalidCommand, "--ref f");

        assert.deepEqual(
            suggestions?.map((item) => item.value),
            ["--ref feature", '--ref "quoted value"'],
        );
        assert.deepEqual(
            suggestions?.map((item) => item.label),
            ["feature", "quoted"],
        );
    });

    it("contains asynchronously rejected completion providers", async () => {
        const rejectingCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                ref: {
                    type: "string",
                    async completeAsync() {
                        throw new Error("provider rejected");
                    },
                },
            },
        };

        assert.equal(await getTypedArgumentCompletions(rejectingCommand, "--ref f"), null);
    });

    it("settles async completion immediately when its parent signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        let providerCalls = 0;
        const abortedCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                ref: {
                    type: "string",
                    completionTimeoutMs: 1,
                    async completeAsync() {
                        providerCalls += 1;

                        return new Promise<readonly []>(() => {});
                    },
                },
            },
        };
        const capabilities = createPiCompletionCapabilities(
            process.cwd(),
            completionRegistry,
            controller.signal,
        );

        const result = await Promise.race([
            getTypedArgumentCompletions(abortedCommand, "--ref f", capabilities),
            new Promise<"deadline">((resolve) => {
                setTimeout(() => resolve("deadline"), 25);
            }),
        ]);

        assert.equal(providerCalls, 0);
        assert.equal(result, null);
    });

    it("times out async completion providers and passes an abort signal", async () => {
        let sawSignal = false;
        let aborted = false;
        const timeoutCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                ref: {
                    type: "string",
                    completionTimeoutMs: 1,
                    async completeAsync(_query, context) {
                        sawSignal = context.signal !== undefined;
                        const completion = createTestSignal<[]>();
                        context.signal?.addEventListener("abort", () => {
                            aborted = true;
                            completion.resolve([]);
                        });

                        return completion.promise;
                    },
                },
            },
        };
        const capabilities: CompletionCapabilities = {
            ...completionCapabilities(),
            scheduler: {
                async run(work, timeoutMs) {
                    assert.equal(timeoutMs, 1);
                    const controller = new AbortController();
                    const workCompletion = work(controller.signal);
                    controller.abort();
                    await workCompletion;

                    return undefined;
                },
            },
        };

        assert.equal(
            await getTypedArgumentCompletions(timeoutCommand, "--ref f", capabilities),
            null,
        );
        assert.equal(sawSignal, true);
        assert.equal(aborted, true);
    });

    it("completes command widget values from typed commands", async () => {
        const commandArgument: RegisteredTypedCommand = {
            ...command,
            args: {
                next: { type: "string", ui: { widget: "command" } },
            },
        };

        await withRegisteredCommandAsync(command, async () => {
            const suggestions = await getTypedArgumentCompletions(commandArgument, "--next /de");

            assert.deepEqual(
                suggestions?.map((item) => item.value),
                ["--next /deploy"],
            );
        });
    });

    it("completes path widget values from the cwd", async () => {
        const dir = mkdtempSync(join(tmpdir(), "pi-typed-path-complete-"));
        mkdirSync(join(dir, "src"));
        symlinkSync(join(dir, "src"), join(dir, "linked-src"), "dir");
        writeFileSync(join(dir, "README.md"), "demo");
        writeFileSync(join(dir, ".hidden"), "hidden");
        writeFileSync(join(dir, "bad\u001b[31m"), "control sequence");
        const pathCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                target: { type: "string", ui: { widget: "path" } },
            },
        };
        const previous = process.cwd();
        process.chdir(dir);
        try {
            const suggestions = await getTypedArgumentCompletions(pathCommand, "--target s");
            const fileWidget = await getTypedArgumentCompletions(
                {
                    ...pathCommand,
                    args: { target: { type: "string", ui: { widget: "file" } } },
                },
                "--target R",
            );
            const directoryWidget = await getTypedArgumentCompletions(
                {
                    ...pathCommand,
                    args: { target: { type: "string", ui: { widget: "directory" } } },
                },
                "--target s",
            );
            const linkedDirectory = await getTypedArgumentCompletions(
                pathCommand,
                "--target linked",
            );
            const emptyQuery = await getTypedArgumentCompletions(pathCommand, "--target ");

            assert.deepEqual(
                suggestions?.map((item) => item.value),
                ["--target src/"],
            );
            assert.deepEqual(
                fileWidget?.map((item) => item.value),
                ["--target README.md"],
            );
            assert.deepEqual(
                directoryWidget?.map((item) => item.value),
                ["--target src/"],
            );
            assert.deepEqual(
                linkedDirectory?.map((item) => item.value),
                ["--target linked-src/"],
            );
            assert.deepEqual(
                new Set(emptyQuery?.map((item) => item.value)),
                new Set([
                    "--target .hidden",
                    "--target linked-src/",
                    "--target README.md",
                    "--target src/",
                ]),
            );
        } finally {
            process.chdir(previous);
        }
    });

    it("keeps repeatable multi-enum flags available", () => {
        withRegisteredCommand(command, () => {
            const suggestions = getTypedAutocompleteSuggestions(["/deploy --tags api "], 0, 19);

            assert.equal(
                suggestions?.items.some((item) => item.label === "--tags"),
                true,
            );
        });
    });

    it("completes multi-enum values", () => {
        withRegisteredCommand(command, () => {
            const suggestions = getTypedAutocompleteSuggestions(["/deploy --tags w"], 0, 16);
            assert.equal(suggestions?.prefix, "w");
            assert.deepEqual(
                suggestions?.items.map((item) => item.value),
                ["web", "worker"],
            );
        });
    });

    it("uses quoted source prefixes for editor value completions", () => {
        const quoteCommand: RegisteredTypedCommand = {
            ...command,
            name: "quote-complete",
            args: {
                ref: {
                    type: "string",
                    complete: (query) =>
                        ["feature branch", 'feat"quote', String.raw`path\name`]
                            .filter((value) => value.startsWith(query))
                            .map((value) => ({ value })),
                },
            },
        };
        withRegisteredCommand(quoteCommand, () => {
            const quotedLine = '/quote-complete --ref "fea';
            const quoted = getTypedAutocompleteSuggestions([quotedLine], 0, quotedLine.length);
            const inlineLine = '/quote-complete --ref="pa';
            const inline = getTypedAutocompleteSuggestions([inlineLine], 0, inlineLine.length);
            assert.equal(quoted?.prefix, '"fea');
            assert.deepEqual(
                quoted?.items.map((item) => item.value),
                [JSON.stringify("feature branch"), JSON.stringify('feat"quote')],
            );
            assert.equal(inline?.prefix, '--ref="pa');
            assert.deepEqual(
                inline?.items.map((item) => item.value),
                [`--ref=${JSON.stringify(String.raw`path\name`)}`],
            );
        });
    });
});
