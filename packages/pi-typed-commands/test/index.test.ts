import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installTypedCommandUx, registerTypedCommand } from "../src/index.js";
import {
    combineSkillAdditionalInput,
    decideArgumentIssueAction,
    decideTypedCommandPreflight,
    parseSlashCommandText,
} from "../src/invocation.js";
import type { ParseIssue } from "../src/types.js";

void describe("typed invocation policy", () => {
    void it("falls back when typed args are disabled and a fallback exists", () => {
        assert.deepEqual(
            decideTypedCommandPreflight({
                typedCommandEnabled: false,
                shouldUseTypedArgs: true,
                hasFallback: true,
            }),
            { action: "fallback", reason: "disabled" },
        );
    });

    void it("stops instead of typed parsing when typed args are bypassed without a fallback", () => {
        assert.deepEqual(
            decideTypedCommandPreflight({
                typedCommandEnabled: true,
                shouldUseTypedArgs: false,
                hasFallback: false,
            }),
            { action: "stop", reason: "bypassed" },
        );
    });

    void it("opens forms for named validation issues but not structural parse issues", () => {
        const missingRequired: ParseIssue = {
            kind: "missing-required",
            name: "path",
            message: "--path is required",
        };
        const unknownArgument: ParseIssue = {
            kind: "unknown-argument",
            token: "--bad",
            message: "Unknown argument --bad",
        };

        assert.equal(
            decideArgumentIssueAction(
                {
                    openFormWhenInvalid: true,
                    openFormWhenMissingRequired: true,
                },
                [missingRequired],
            ),
            "open-form",
        );
        assert.equal(
            decideArgumentIssueAction(
                {
                    openFormWhenInvalid: true,
                    openFormWhenMissingRequired: true,
                },
                [unknownArgument, missingRequired],
            ),
            "notify",
        );
    });
});

void describe("registerTypedCommand", () => {
    void it("rejects colliding and reserved TypeScript argument flags", () => {
        const pi = { registerCommand() {} } as unknown as ExtensionAPI;

        assert.throws(
            () =>
                registerTypedCommand(pi, "bad", {
                    description: "Bad command",
                    args: {
                        fooBar: { type: "string" },
                        "foo-bar": { type: "string" },
                    },
                    handler() {},
                }),
            /foo-bar: flag --foo-bar collides with fooBar/,
        );

        assert.throws(
            () =>
                registerTypedCommand(pi, "bad-no", {
                    description: "Bad command",
                    args: {
                        noCache: { type: "boolean" },
                    },
                    handler() {},
                }),
            /noCache: argument flags may not start with no-/,
        );

        assert.throws(
            () =>
                registerTypedCommand(pi, "bad-help", {
                    description: "Bad command",
                    args: {
                        help: { type: "boolean" },
                    },
                    handler() {},
                }),
            /help: argument flag --help is reserved/,
        );
    });
});

void describe("slash command text parsing", () => {
    void it("preserves the body after the first slash-command line", () => {
        assert.deepEqual(parseSlashCommandText("/skill:demo src --fix\nline one\nline two"), {
            commandName: "skill:demo",
            rawArgs: "src --fix",
            trailingBody: "line one\nline two",
        });
    });

    void it("combines unexpected positional leftovers with multi-line skill body text", () => {
        assert.equal(
            combineSkillAdditionalInput("extra words", "line one\nline two"),
            "extra words\nline one\nline two",
        );
    });

    void it("ignores non-command text", () => {
        assert.equal(parseSlashCommandText("please run skill:demo"), undefined);
    });
});
