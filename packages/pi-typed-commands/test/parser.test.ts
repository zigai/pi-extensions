import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
    getTypedArgumentCompletions,
    getTypedAutocompleteSuggestions,
} from "../src/completions.js";
import {
    formatCommandUsage,
    parseTypedCommandArgs,
    serializeTypedCommandArgs,
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

    void it("accepts negative numeric flag values", () => {
        const parsed = parseTypedCommandArgs(command, "--env dev --count -1");

        assert.equal(parsed.values.count, undefined);
        assert.equal(parsed.issues[0]?.message, "--count must be at least 1");
    });

    void it("supports -- as an end-of-options marker", () => {
        const parsed = parseTypedCommandArgs(branchCommand, "create -- --literal-branch");

        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.action, "create");
        assert.equal(parsed.values.name, "--literal-branch");
    });

    void it("does not treat --help after -- as help mode", () => {
        const parsed = parseTypedCommandArgs(branchCommand, "create -- --help");

        assert.equal(parsed.mode, "run");
        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.name, "--help");
    });

    void it("parses negative positional numbers when a number positional is expected", () => {
        const numericCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                offset: {
                    type: "number",
                    positional: 0,
                    min: -5,
                },
            },
        };
        const parsed = parseTypedCommandArgs(numericCommand, "-1");

        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.offset, -1);
    });

    void it("parses positional args before named flags", () => {
        const parsed = parseTypedCommandArgs(branchCommand, "create feature/foo --base main");

        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.action, "create");
        assert.equal(parsed.values.name, "feature/foo");
        assert.equal(parsed.values.base, "main");
    });

    void it("supports the explicit position field for positional args", () => {
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

    void it("consumes rest positional string arguments", () => {
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

    void it("recognizes --help and -h", () => {
        const longHelp = parseTypedCommandArgs(command, "--help");
        const shortHelp = parseTypedCommandArgs(command, "-h");

        assert.equal(longHelp.mode, "help");
        assert.equal(shortHelp.mode, "help");
    });

    void it("parses quoted and escaped values", () => {
        const parsed = parseTypedCommandArgs(
            command,
            '--env dev --ref "feature with spaces" --tags api\\,web',
        );

        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.ref, "feature with spaces");
        assert.deepEqual(parsed.values.tags, ["api", "web"]);
    });

    void it("reports unterminated quotes without discarding parsed values", () => {
        const parsed = parseTypedCommandArgs(command, '--env dev --ref "feature');

        assert.equal(parsed.values.env, "dev");
        assert.equal(parsed.values.ref, "feature");
        assert.equal(parsed.issues[0]?.kind, "unterminated-quote");
    });

    void it("parses inline flag values and explicit booleans", () => {
        const parsed = parseTypedCommandArgs(command, "--env=prod --dry-run=false");

        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.env, "prod");
        assert.equal(parsed.values.dryRun, false);
    });

    void it("rejects empty inline number values instead of coercing them to zero", () => {
        const parsed = parseTypedCommandArgs(command, "--env dev --count=");

        assert.equal(parsed.values.count, undefined);
        assert.deepEqual(
            parsed.issues.map((issue) => [issue.kind, issue.name, issue.message]),
            [["invalid-value", "count", "--count expects a number"]],
        );
    });

    void it("clones multi-enum defaults for each parse result", () => {
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

    void it("reports unknown flags, missing values, and invalid no-flags", () => {
        const parsed = parseTypedCommandArgs(command, "--unknown --ref --no-ref");

        assert.deepEqual(
            parsed.issues.map((issue) => issue.kind),
            ["unknown-argument", "missing-value", "invalid-value", "missing-required"],
        );
    });

    void it("preserves Windows paths and empty quoted strings", () => {
        const pathCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                path: { type: "string", required: true, positional: 0 },
                label: { type: "string", positional: 1 },
            },
        };

        const windowsPath = parseTypedCommandArgs(pathCommand, String.raw`C:\Users\me\file.txt ""`);

        assert.deepEqual(windowsPath.issues, []);
        assert.equal(windowsPath.values.path, String.raw`C:\Users\me\file.txt`);
        assert.equal(windowsPath.values.label, "");
    });

    void it("treats quoted help as a literal value", () => {
        const pathCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                path: { type: "string", required: true, positional: 0 },
            },
        };

        const parsed = parseTypedCommandArgs(pathCommand, '"--help"');

        assert.equal(parsed.mode, "run");
        assert.deepEqual(parsed.issues, []);
        assert.equal(parsed.values.path, "--help");
    });

    void it("marks invalid provided values without duplicating required diagnostics", () => {
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

    void it("rejects inline values on no-boolean flags", () => {
        const parsed = parseTypedCommandArgs(command, "--env dev --no-dry-run=true");

        assert.equal(parsed.values.dryRun, undefined);
        assert.deepEqual(
            parsed.issues.map((issue) => [issue.kind, issue.name]),
            [["invalid-value", "dryRun"]],
        );
    });

    void it("supports explicit flag names and aliases", () => {
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

    void it("runs command-level cross-field validation", () => {
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

    void it("makes duplicate occurrence behavior explicit", () => {
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

    void it("serializes values into parseable command arguments", () => {
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

    void it("completes inline enum values", () => {
        registerTypedCommandMetadata(command);

        const suggestions = getTypedAutocompleteSuggestions(["/deploy --env=d"], 0, 15);

        assert.equal(suggestions?.prefix, "--env=d");
        assert.deepEqual(
            suggestions?.items.map((item) => item.value),
            ["--env=dev"],
        );
    });

    void it("completes values through Pi's command completion entry point", async () => {
        const suggestions = await getTypedArgumentCompletions(command, "--env d");

        assert.deepEqual(
            suggestions?.map((item) => item.value),
            ["dev"],
        );
    });

    void it("quotes completed values when insertion would need shell quoting", async () => {
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
            ['"feature branch"'],
        );
        assert.deepEqual(
            dashed?.map((item) => item.value),
            ['"-dash"'],
        );
    });

    void it("honors provider-supplied replacement text", async () => {
        const refCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                ref: {
                    type: "string",
                    complete: () => [
                        {
                            value: "feature branch",
                            replacement: '"feature branch"',
                            replaceRange: { start: 6, end: 13 },
                        },
                    ],
                },
            },
        };

        const suggestions = await getTypedArgumentCompletions(refCommand, "--ref feature");

        assert.deepEqual(
            suggestions?.map((item) => item.value),
            ['"feature branch"'],
        );
    });

    void it("completes positional values", async () => {
        registerTypedCommandMetadata(branchCommand);

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

    void it("stops completing flags after the end-of-options marker", async () => {
        registerTypedCommandMetadata(command);

        assert.equal(await getTypedArgumentCompletions(command, "-- --e"), null);
        assert.equal(getTypedAutocompleteSuggestions(["/deploy -- --e"], 0, 14), undefined);
    });

    void it("supports async value completion providers", async () => {
        const asyncCommand: RegisteredTypedCommand = {
            ...command,
            args: {
                ref: {
                    type: "string",
                    complete: async (query) =>
                        ["main", "feature/login"]
                            .filter((value) => value.startsWith(query))
                            .map((value) => ({ value })),
                },
            },
        };

        const suggestions = await getTypedArgumentCompletions(asyncCommand, "--ref f");

        assert.deepEqual(
            suggestions?.map((item) => item.value),
            ["feature/login"],
        );
    });

    void it("completes command widget values from typed commands", async () => {
        registerTypedCommandMetadata(command);
        const commandArgument: RegisteredTypedCommand = {
            ...command,
            args: {
                next: { type: "string", ui: { widget: "command" } },
            },
        };

        const suggestions = await getTypedArgumentCompletions(commandArgument, "--next /de");

        assert.deepEqual(
            suggestions?.map((item) => item.value),
            ["/deploy"],
        );
    });

    void it("completes path widget values from the cwd", async () => {
        const dir = mkdtempSync(join(tmpdir(), "pi-typed-path-complete-"));
        mkdirSync(join(dir, "src"));
        writeFileSync(join(dir, "README.md"), "demo");
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

            assert.deepEqual(
                suggestions?.map((item) => item.value),
                ["src/"],
            );
        } finally {
            process.chdir(previous);
        }
    });

    void it("keeps repeatable multi-enum flags available", () => {
        registerTypedCommandMetadata(command);

        const suggestions = getTypedAutocompleteSuggestions(["/deploy --tags api "], 0, 19);

        assert.equal(
            suggestions?.items.some((item) => item.label === "--tags"),
            true,
        );
    });

    void it("completes multi-enum values", () => {
        registerTypedCommandMetadata(command);

        const suggestions = getTypedAutocompleteSuggestions(["/deploy --tags w"], 0, 16);

        assert.equal(suggestions?.prefix, "w");
        assert.deepEqual(
            suggestions?.items.map((item) => item.value),
            ["web", "worker"],
        );
    });
});
