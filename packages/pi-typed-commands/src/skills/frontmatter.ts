import YAML from "yaml";
import { skillArgumentDiagnostic } from "./diagnostics.js";
import { isRecord, optionalString } from "./guards.js";
import type {
    ParseSkillMarkdownResult,
    SkillArgumentDiagnostic,
    SkillFrontmatter,
} from "./types.js";

const FRONTMATTER_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/;

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
        parsed = YAML.parse(yamlText) as unknown;
    } catch (error) {
        let message = "frontmatter: invalid YAML";
        if (error instanceof Error) {
            message = `frontmatter: invalid YAML: ${error.message}`;
        }
        return {
            status: "invalid",
            body,
            diagnostics: [
                skillArgumentDiagnostic({
                    code: "skill.frontmatter.yaml.invalid",
                    message,
                    path: ["frontmatter"],
                }),
            ],
        };
    }
    if (!isRecord(parsed)) {
        return { status: "ok", frontmatter: {}, body };
    }

    const frontmatter: SkillFrontmatter = {};
    const diagnostics: SkillArgumentDiagnostic[] = [];
    if (Object.hasOwn(parsed, "name")) {
        const name = optionalString(parsed.name);
        if (name === undefined) {
            diagnostics.push(
                skillArgumentDiagnostic({
                    code: "skill.frontmatter.name.invalid",
                    message: "frontmatter.name must be a string",
                    path: ["frontmatter", "name"],
                }),
            );
        } else {
            frontmatter.name = name;
        }
    }

    if (Object.hasOwn(parsed, "description")) {
        const description = optionalString(parsed.description);
        if (description === undefined) {
            diagnostics.push(
                skillArgumentDiagnostic({
                    code: "skill.frontmatter.description.invalid",
                    message: "frontmatter.description must be a string",
                    path: ["frontmatter", "description"],
                }),
            );
        } else {
            frontmatter.description = description;
        }
    }

    if (Object.hasOwn(parsed, "form_title")) {
        const formTitle = optionalString(parsed.form_title);
        if (formTitle === undefined) {
            diagnostics.push(
                skillArgumentDiagnostic({
                    code: "skill.frontmatter.form_title.invalid",
                    message: "frontmatter.form_title must be a string",
                    path: ["frontmatter", "form_title"],
                }),
            );
        } else {
            frontmatter.formTitle = formTitle;
        }
    }

    if (diagnostics.length > 0) {
        return { status: "invalid", body, diagnostics };
    }

    if (Object.hasOwn(parsed, "arguments")) {
        frontmatter.arguments = parsed.arguments;
    }
    return { status: "ok", frontmatter, body };
}
