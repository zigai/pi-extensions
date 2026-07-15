import type { TLocalizedValidationError } from "typebox/error";
import Schema from "../typebox-schema.js";
import YAML from "yaml";
import { skillArgumentDiagnostic } from "./diagnostics.js";
import { SkillFrontmatterYamlSchema } from "./schema.js";
import type {
    ParseSkillMarkdownResult,
    SkillArgumentDiagnostic,
    SkillFrontmatter,
} from "./types.js";

const FRONTMATTER_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/;

function pointerSegments(pointer: string): string[] {
    if (pointer.length === 0) {
        return [];
    }
    return pointer
        .slice(1)
        .split("/")
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function frontmatterFieldError(error: TLocalizedValidationError): SkillArgumentDiagnostic {
    const field = pointerSegments(error.instancePath)[0];
    if (field === "name" || field === "description" || field === "form_title") {
        return skillArgumentDiagnostic({
            code: `skill.frontmatter.${field}.invalid`,
            message: `frontmatter.${field} must be a string`,
            path: ["frontmatter", field],
        });
    }

    return skillArgumentDiagnostic({
        code: "skill.frontmatter.invalid",
        message: "frontmatter must be an object",
        path: ["frontmatter"],
    });
}

function parseFrontmatterFields(
    parsed: unknown,
):
    | { status: "ok"; frontmatter: SkillFrontmatter }
    | { status: "invalid"; diagnostics: SkillArgumentDiagnostic[] } {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {
            status: "invalid",
            diagnostics: [
                skillArgumentDiagnostic({
                    code: "skill.frontmatter.invalid",
                    message: "frontmatter must be an object",
                    path: ["frontmatter"],
                }),
            ],
        };
    }

    if (!Schema.Check(SkillFrontmatterYamlSchema, parsed)) {
        const [, errors] = Schema.Errors(SkillFrontmatterYamlSchema, parsed);
        return { status: "invalid", diagnostics: errors.map(frontmatterFieldError) };
    }

    const yaml = parsed;
    const frontmatter: SkillFrontmatter = {};
    if (yaml.name !== undefined) {
        frontmatter.name = yaml.name;
    }
    if (yaml.description !== undefined) {
        frontmatter.description = yaml.description;
    }
    if (yaml.form_title !== undefined) {
        frontmatter.formTitle = yaml.form_title;
    }
    if (yaml.arguments !== undefined) {
        frontmatter.arguments = yaml.arguments;
    }
    return { status: "ok", frontmatter };
}

/** Parse a `SKILL.md` document into frontmatter fields and trimmed Markdown body. */
export function parseSkillMarkdown(content: string): ParseSkillMarkdownResult {
    const match = FRONTMATTER_PATTERN.exec(content);
    if (match === null) {
        return { status: "ok", frontmatter: {}, body: content.trim() };
    }

    const yamlText = match[1] ?? "";
    const body = (match[2] ?? "").trim();
    let parsed: unknown;
    try {
        parsed = YAML.parse(yamlText);
    } catch {
        return {
            status: "invalid",
            body,
            diagnostics: [
                skillArgumentDiagnostic({
                    code: "skill.frontmatter.yaml.invalid",
                    message: "frontmatter: invalid YAML",
                    path: ["frontmatter"],
                }),
            ],
        };
    }
    const frontmatterResult = parseFrontmatterFields(parsed);
    if (frontmatterResult.status === "invalid") {
        return { status: "invalid", body, diagnostics: frontmatterResult.diagnostics };
    }
    return { status: "ok", frontmatter: frontmatterResult.frontmatter, body };
}
