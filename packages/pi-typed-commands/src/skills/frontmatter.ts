import YAML from "yaml";
import { isRecord, optionalString } from "./guards.js";
import type { SkillFrontmatter } from "./types.js";

const FRONTMATTER_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/;

/** Parse a `SKILL.md` document into frontmatter fields and trimmed Markdown body. */
export function parseSkillMarkdown(content: string): {
    frontmatter: SkillFrontmatter;
    body: string;
} {
    const match = FRONTMATTER_PATTERN.exec(content);
    if (match === null) {
        return { frontmatter: {}, body: content.trim() };
    }

    const yamlText = match[1] ?? "";
    const body = (match[2] ?? "").trim();
    const parsed = YAML.parse(yamlText) as unknown;
    if (!isRecord(parsed)) {
        return { frontmatter: {}, body };
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
    return { frontmatter, body };
}
