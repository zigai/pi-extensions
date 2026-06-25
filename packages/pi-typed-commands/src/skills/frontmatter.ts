import YAML from "yaml";
import { skillArgumentDiagnostic } from "./diagnostics.js";
import { isRecord, optionalString } from "./guards.js";
import type { ParseSkillMarkdownResult, SkillFrontmatter } from "./types.js";

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
    const name = optionalString(parsed.name);
    if (name !== undefined) {
        frontmatter.name = name;
    }
    const description = optionalString(parsed.description);
    if (description !== undefined) {
        frontmatter.description = description;
    }
    const formTitle = optionalString(parsed.form_title);
    if (formTitle !== undefined) {
        frontmatter.formTitle = formTitle;
    }
    if (Object.hasOwn(parsed, "arguments")) {
        frontmatter.arguments = parsed.arguments;
    }
    return { status: "ok", frontmatter, body };
}
