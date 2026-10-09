import fs from "node:fs/promises";

export type SkillExpansion = {
    name: string;
    location: string;
    body: string;
    baseDir: string;
};

export type SkillExpansionTarget = Omit<SkillExpansion, "body">;
export type SkillExpansionLoader = (target: SkillExpansionTarget) => Promise<SkillExpansion>;

type CachedSkillExpansion = {
    mtimeMs: number;
    expansion: SkillExpansion;
};

export function stripFrontmatter(content: string): string {
    if (!content.startsWith("---")) return content;

    const end = content.indexOf("\n---", 3);
    if (end === -1) return content;

    const afterMarker = end + "\n---".length;
    if (content[afterMarker] === "\r" && content[afterMarker + 1] === "\n") {
        return content.slice(afterMarker + 2);
    }

    if (content[afterMarker] === "\n") {
        return content.slice(afterMarker + 1);
    }

    return content.slice(afterMarker);
}

async function loadSkillExpansion(target: SkillExpansionTarget): Promise<SkillExpansion> {
    const content = await fs.readFile(target.location, "utf8");
    const body = stripFrontmatter(content).trim();
    return { ...target, body };
}

export function createCachedSkillExpansionLoader(): SkillExpansionLoader {
    const cache = new Map<string, CachedSkillExpansion>();
    return async (target) => {
        const stats = await fs.stat(target.location);
        const cached = cache.get(target.location);
        if (cached?.mtimeMs === stats.mtimeMs) {
            return cached.expansion;
        }

        const expansion = await loadSkillExpansion(target);
        cache.set(target.location, { mtimeMs: stats.mtimeMs, expansion });

        return expansion;
    };
}

export function formatSkillBlock(expansion: SkillExpansion): string {
    return `<skill name="${expansion.name}" location="${expansion.location}">\nReferences are relative to ${expansion.baseDir}.\n\n${expansion.body}\n</skill>`;
}
