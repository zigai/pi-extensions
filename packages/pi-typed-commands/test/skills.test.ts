import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTypedCommandArgs, type RegisteredTypedCommand } from "../src/index.js";
import {
    normalizeSkillArguments,
    parseSkillMarkdown,
    renderTypedSkillInvocation,
    typedSkillCommandFromMetadata,
    type TypedSkillMetadata,
} from "../src/skills.js";

const formSymbols = {
    selectedCheckbox: "■",
    unselectedCheckbox: "□",
    selectedRadio: "●",
    unselectedRadio: "○",
};

void describe("normalizeSkillArguments", () => {
    void it("normalizes snake_case skill metadata into argument definitions", () => {
        const result = normalizeSkillArguments({
            path: {
                type: "string",
                positional: 0,
                default: ".",
                description: "Target path",
            },
            fix: {
                type: "boolean",
                default: true,
            },
            rules: {
                type: "multi_enum",
                values: ["E", "F"],
                required: false,
            },
            config: {
                output_path: {
                    type: "string",
                    required: true,
                },
            },
        });

        assert.deepEqual(result.warnings, []);
        assert.equal(result.args.path?.type, "string");
        assert.equal(result.args.path?.default, ".");
        assert.equal(result.args.fix?.type, "boolean");
        assert.equal(result.args.fix?.default, true);
        assert.equal(result.args.rules?.type, "multi-enum");
        assert.deepEqual(result.args.rules?.values, ["E", "F"]);
        assert.equal(result.args["config.output_path"]?.type, "string");
        assert.equal(result.args["config.output_path"]?.required, true);
    });

    void it("parses skill frontmatter metadata", () => {
        const parsed = parseSkillMarkdown(`---
name: demo
description: Demo skill
metadata:
  form_title: Demo Form
  arguments:
    path:
      type: string
---

Use {args.path}.
`);

        assert.equal(parsed.frontmatter.name, "demo");
        assert.equal(parsed.frontmatter.description, "Demo skill");
        assert.deepEqual(parsed.frontmatter.metadata?.arguments, { path: { type: "string" } });
        assert.equal(parsed.body, "Use {args.path}.");
    });
});

void describe("typed skill required/default behavior", () => {
    void it("does not report a required argument as missing when it has a default", () => {
        const command: RegisteredTypedCommand = {
            name: "skill:demo",
            description: "Demo skill",
            args: {
                path: {
                    type: "string",
                    required: true,
                    default: ".",
                },
                token: {
                    type: "string",
                    required: true,
                },
            },
            handler: () => {},
            typedArgsEnabled: true,
            formSymbols,
            openFormWhenInvalid: true,
            openFormWhenMissingRequired: true,
        };

        const parsed = parseTypedCommandArgs(command, "");

        assert.equal(parsed.values.path, ".");
        assert.deepEqual(
            parsed.issues.map((issue) => [issue.kind, issue.name]),
            [["missing-required", "token"]],
        );
    });
});

void describe("renderTypedSkillInvocation", () => {
    const skill: TypedSkillMetadata = {
        name: "fix-ruff-errors",
        description: "Fix Ruff lint errors",
        filePath: "/tmp/skills/fix-ruff-errors/SKILL.md",
        baseDir: "/tmp/skills/fix-ruff-errors",
        body: "Run on {args.path}. Fix: {args.fix}. Output: {args.config.output_path}.",
        args: {},
    };

    void it("renders placeholders including nested argument paths", () => {
        const rendered = renderTypedSkillInvocation({
            skill,
            values: {
                path: "src",
                fix: false,
                "config.output_path": "report.txt",
            },
        });

        assert.match(rendered, /<skill name="fix-ruff-errors"/);
        assert.match(rendered, /Run on src\. Fix: false\. Output: report\.txt\./);
        assert.doesNotMatch(rendered, /ARGUMENTS:/);
    });

    void it("appends fallback arguments and additional input when no placeholders are present", () => {
        const rendered = renderTypedSkillInvocation({
            skill: {
                ...skill,
                body: "Follow the workflow.",
            },
            values: {
                path: "src",
                rules: ["E", "F"],
                "config.output_path": "report.txt",
            },
            additionalInput: "only report risky fixes",
        });

        assert.match(rendered, /ARGUMENTS:\n```yaml\n/);
        assert.match(rendered, /path: src/);
        assert.match(rendered, /rules:\n  - E\n  - F/);
        assert.match(rendered, /config:\n  output_path: report\.txt/);
        assert.match(rendered, /ADDITIONAL_INPUT:\nonly report risky fixes/);
    });

    void it("creates a typed skill command from metadata", () => {
        const command = typedSkillCommandFromMetadata(skill);

        assert.equal(command.name, "skill:fix-ruff-errors");
        assert.equal(command.source, "skill");
        assert.equal(command.skill.filePath, skill.filePath);
    });
});
