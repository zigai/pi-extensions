import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { compileTypedCommandDefinition } from "../compiler.js";
import { normalizeSkillArguments } from "./argument-normalizer.js";
import { skillArgumentDiagnostic, typedSkillDiagnostics } from "./diagnostics.js";
import { parseSkillMarkdown } from "./frontmatter.js";
import { PLACEHOLDER_PATTERN } from "./prompt.js";
import type {
    ArgumentDefinitions,
    ReadTypedSkillMetadataResult,
    SkillArgumentDiagnostic,
    TypedSkillMetadata,
} from "./types.js";

function validateSkillPlaceholders(
    body: string,
    args: ArgumentDefinitions,
): SkillArgumentDiagnostic[] {
    const diagnostics: SkillArgumentDiagnostic[] = [];
    const names = Object.keys(args);
    PLACEHOLDER_PATTERN.lastIndex = 0;
    for (const match of body.matchAll(PLACEHOLDER_PATTERN)) {
        const path = match[1];
        if (path === undefined) {
            continue;
        }
        const valid =
            Object.hasOwn(args, path) || names.some((name) => name.startsWith(`${path}.`));
        if (!valid) {
            diagnostics.push(
                skillArgumentDiagnostic({
                    code: "skill.body.placeholder.unknown",
                    message: `body: unknown argument placeholder {args.${path}}`,
                    path: ["body", "args", path],
                }),
            );
        }
    }
    return diagnostics;
}

/** Read and validate typed skill metadata from a `SKILL.md` file. */
export function readTypedSkillMetadataResult(filePath: string): ReadTypedSkillMetadataResult {
    const content = readFileSync(filePath, "utf8");
    const { frontmatter, body } = parseSkillMarkdown(content);
    if (frontmatter.name === undefined || frontmatter.description === undefined) {
        return {};
    }

    const rawArguments = frontmatter.arguments;
    if (rawArguments === undefined) {
        return {};
    }

    const { args, diagnostics } = normalizeSkillArguments(rawArguments);
    const allDiagnostics = [...diagnostics, ...validateSkillPlaceholders(body, args)];
    if (allDiagnostics.length > 0) {
        return {
            diagnostics: typedSkillDiagnostics(frontmatter.name, filePath, allDiagnostics),
        };
    }
    if (Object.keys(args).length === 0) {
        return {
            diagnostics: typedSkillDiagnostics(frontmatter.name, filePath, [
                skillArgumentDiagnostic({
                    code: "skill.arguments.empty",
                    message: "arguments must define at least one argument",
                    path: ["arguments"],
                }),
            ]),
        };
    }

    const compiled = compileTypedCommandDefinition({
        name: `skill:${frontmatter.name}`,
        description: frontmatter.description,
        args,
    });
    if (!compiled.ok) {
        return {
            diagnostics: typedSkillDiagnostics(frontmatter.name, filePath, compiled.diagnostics),
        };
    }

    const formTitle = frontmatter.formTitle;
    const metadata: TypedSkillMetadata = {
        name: frontmatter.name,
        description: frontmatter.description,
        filePath,
        baseDir: dirname(filePath),
        body,
        args: compiled.command.args as ArgumentDefinitions,
    };
    if (formTitle !== undefined) {
        metadata.formTitle = formTitle;
    }
    return { metadata };
}

/** Read typed skill metadata, returning `undefined` when absent or invalid. */
export function readTypedSkillMetadata(filePath: string): TypedSkillMetadata | undefined {
    const result = readTypedSkillMetadataResult(filePath);
    return result.metadata;
}
