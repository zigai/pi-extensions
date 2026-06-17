import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
