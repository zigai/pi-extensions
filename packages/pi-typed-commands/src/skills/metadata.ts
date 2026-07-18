import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { compileTypedCommandDefinition } from "../compiler.js";
import { normalizeSkillArguments } from "./argument-normalizer.js";
import { skillArgumentDiagnostic, typedSkillDiagnostics } from "./diagnostics.js";
import { parseSkillMarkdown } from "./frontmatter.js";
import { PLACEHOLDER_PATTERN } from "./prompt.js";
import type {
    FlatArgumentDefinitions,
    ReadTypedSkillMetadataOptions,
    ReadTypedSkillMetadataResult,
    SkillArgumentDiagnostic,
    TypedSkillMetadata,
} from "./types.js";

function validateSkillPlaceholders(
    body: string,
    args: FlatArgumentDefinitions,
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

function fileReadErrorCode(cause: unknown): string | undefined {
    if (typeof cause !== "object" || cause === null || !("code" in cause)) {
        return undefined;
    }

    if (typeof cause.code === "string") {
        return cause.code;
    }
    return undefined;
}

function fileReadErrorMessage(cause: unknown): string {
    const code = fileReadErrorCode(cause);
    if (code !== undefined) {
        return `failed to read typed arguments (${code})`;
    }
    return "failed to read typed arguments";
}

/** Read and validate typed skill metadata from a `SKILL.md` file. */
export function readTypedSkillMetadataResult(
    filePath: string,
    options: ReadTypedSkillMetadataOptions = {},
): ReadTypedSkillMetadataResult {
    let content: string;
    try {
        content = readFileSync(filePath, "utf8");
    } catch (cause: unknown) {
        return {
            status: "invalid",
            diagnostics: typedSkillDiagnostics(options.fallbackName ?? "unknown", filePath, [
                skillArgumentDiagnostic({
                    code: "skill.arguments.read_failed",
                    message: fileReadErrorMessage(cause),
                    path: [],
                }),
            ]),
        };
    }
    const parsedSkill = parseSkillMarkdown(content);
    if (parsedSkill.status === "invalid") {
        const diagnosticName = options.fallbackName ?? "unknown";
        return {
            status: "invalid",
            diagnostics: typedSkillDiagnostics(diagnosticName, filePath, parsedSkill.diagnostics),
        };
    }
    const { frontmatter, body } = parsedSkill;
    if (frontmatter.name === undefined || frontmatter.description === undefined) {
        return { status: "absent" };
    }

    const rawArguments = frontmatter.arguments;
    if (rawArguments === undefined) {
        return { status: "absent" };
    }

    const { args, diagnostics } = normalizeSkillArguments(rawArguments);
    const allDiagnostics = [...diagnostics, ...validateSkillPlaceholders(body, args)];
    if (allDiagnostics.length > 0) {
        return {
            status: "invalid",
            diagnostics: typedSkillDiagnostics(frontmatter.name, filePath, allDiagnostics),
        };
    }
    if (Object.keys(args).length === 0) {
        return {
            status: "invalid",
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
            status: "invalid",
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
        args: compiled.command.args,
    };
    if (formTitle !== undefined) {
        metadata.formTitle = formTitle;
    }
    if (frontmatter.metadata?.ghostText !== undefined) {
        metadata.ghostText = frontmatter.metadata.ghostText;
    }
    return { status: "ok", metadata };
}
