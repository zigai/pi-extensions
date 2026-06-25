import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { compileTypedCommandDefinition } from "../compiler.js";
import { normalizeSkillArguments } from "./argument-normalizer.js";
import { typedSkillDiagnostics } from "./diagnostics.js";
import { parseSkillMarkdown } from "./frontmatter.js";
import { PLACEHOLDER_PATTERN } from "./prompt.js";
import type {
    ArgumentDefinitions,
    ReadTypedSkillMetadataResult,
    TypedSkillMetadata,
} from "./types.js";

function validateSkillPlaceholders(body: string, args: ArgumentDefinitions): string[] {
    const warnings: string[] = [];
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
            warnings.push(`body: unknown argument placeholder {args.${path}}`);
        }
    }
    return warnings;
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
    const warnings = diagnostics.map((diagnostic) => diagnostic.message);
    warnings.push(...validateSkillPlaceholders(body, args));
    if (warnings.length > 0) {
        return {
            diagnostics: typedSkillDiagnostics(frontmatter.name, filePath, warnings),
        };
    }
    if (Object.keys(args).length === 0) {
        return {
            diagnostics: typedSkillDiagnostics(frontmatter.name, filePath, [
                "arguments must define at least one argument",
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
            diagnostics: typedSkillDiagnostics(
                frontmatter.name,
                filePath,
                compiled.diagnostics.map((diagnostic) => diagnostic.message),
            ),
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
