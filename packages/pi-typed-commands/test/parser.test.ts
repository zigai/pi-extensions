import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import {
    getTypedArgumentCompletions as resolveTypedArgumentCompletions,
    getTypedAutocompleteSuggestions as resolveTypedAutocompleteSuggestions,
} from "../src/completions.js";
import {
    formatCommandUsage,
    parseTypedCommandArgs,
    serializeTypedCommandArgs,
} from "../src/index.js";
import { createTypedCommandRegistry } from "../src/registry.js";
import { createPiCompletionCapabilities } from "../src/pi/completions.js";
import type { RegisteredTypedCommand } from "../src/types.js";

const completionRegistry = createTypedCommandRegistry();
function completionCapabilities() {
    return createPiCompletionCapabilities(process.cwd(), completionRegistry);
}

function registerTypedCommandMetadata(command: RegisteredTypedCommand): string {
    return completionRegistry.register(command);
}

function getTypedArgumentCompletions(
    command: RegisteredTypedCommand,
    argumentPrefix: string,
) {
    return resolveTypedArgumentCompletions(command, argumentPrefix, completionCapabilities());
}

function getTypedAutocompleteSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
) {
    return resolveTypedAutocompleteSuggestions(
        lines,
        cursorLine,
        cursorCol,
        completionCapabilities(),
    );
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

    it("parses multi-enum comma lists and repeated flags", () => {
        const parsed = parseTypedCommandArgs(command, "--env dev --tags api,web --tags worker");

        assert.deepEqual(parsed.issues, []);
        assert.deepEqual(parsed.values.tags, ["api", "web", "worker"]);
    });

    it("accepts negative numeric flag values", () => {
        const parsed = parseTypedCommandArgs(command, "--env dev --count -1");

        assert.equal(parsed.values.count, undefined);
        assert.equal(parsed.issues[0]?.message, "--count must be at least 1");
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
});

describe("getTypedAutocompleteSuggestions", () => {
    it("suggests flags for typed commands", () => {
        registerTypedCommandMetadata(command);

        const suggestions = getTypedAutocompleteSuggestions(["/deploy --e"], 0, 11);

        assert.equal(suggestions?.prefix, "--e");
        assert.deepEqual(
            suggestions?.items.map((item) => item.label),
            ["--env"],
        );
    });

    it("completes inline enum values", () => {
        registerTypedCommandMetadata(command);

        const suggestions = getTypedAutocompleteSuggestions(["/deploy --env=d"], 0, 15);

        assert.equal(suggestions?.prefix, "--env=d");
        assert.deepEqual(
            suggestions?.items.map((item) => item.value),
            ["--env=dev"],
        );
    });

    it("completes values through Pi's command completion entry point", async () => {
        const suggestions = await getTypedArgumentCompletions(command, "--env d");

        assert.deepEqual(
            suggestions?.map((item) => item.value),
            ["dev"],
        );
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
            ['"feature branch"'],
        );
        assert.deepEqual(
            dashed?.map((item) => item.value),
            ['"-dash"'],
        );
    });

    it("honors provider-supplied replacement text", async () => {
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

    it("completes positional values", async () => {
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

    it("stops completing flags after the end-of-options marker", async () => {
        registerTypedCommandMetadata(command);

        assert.equal(await getTypedArgumentCompletions(command, "-- --e"), null);
        assert.equal(getTypedAutocompleteSuggestions(["/deploy -- --e"], 0, 14), undefined);
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
            ["feature/login"],
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
                    complete: () =>
                        [
                            { value: 123 },
                            { value: "feature", label: 456, description: "valid item" },
                            { value: "quoted", replacement: '"quoted value"' },
                        ] as never,
                },
            },
        };

        assert.equal(await getTypedArgumentCompletions(throwingCommand, "--ref f"), null);
        const suggestions = await getTypedArgumentCompletions(invalidCommand, "--ref f");

        assert.deepEqual(
            suggestions?.map((item) => item.value),
            ["feature", '"quoted value"'],
        );
        assert.deepEqual(
            suggestions?.map((item) => item.label),
            ["feature", "quoted"],
        );
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
                    completeAsync(_query, context) {
                        sawSignal = context.signal !== undefined;
                        context.signal?.addEventListener("abort", () => {
                            aborted = true;
                        });
                        return new Promise(() => {});
                    },
                },
            },
        };

        assert.equal(await getTypedArgumentCompletions(timeoutCommand, "--ref f"), null);
        assert.equal(sawSignal, true);
        assert.equal(aborted, true);
    });

    it("completes command widget values from typed commands", async () => {
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

    it("completes path widget values from the cwd", async () => {
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

    it("keeps repeatable multi-enum flags available", () => {
        registerTypedCommandMetadata(command);

        const suggestions = getTypedAutocompleteSuggestions(["/deploy --tags api "], 0, 19);

        assert.equal(
            suggestions?.items.some((item) => item.label === "--tags"),
            true,
        );
    });

    it("completes multi-enum values", () => {
        registerTypedCommandMetadata(command);

        const suggestions = getTypedAutocompleteSuggestions(["/deploy --tags w"], 0, 16);

        assert.equal(suggestions?.prefix, "w");
        assert.deepEqual(
            suggestions?.items.map((item) => item.value),
            ["web", "worker"],
        );
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
        registerTypedCommandMetadata(quoteCommand);

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
