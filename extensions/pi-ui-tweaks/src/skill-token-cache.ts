import { estimateTokens, VERSION } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

const MAX_ENTRIES = 32;
const CacheDocument = Type.Object(
    {
        version: Type.Literal(1),
        entries: Type.Array(
            Type.Tuple([
                Type.String({ pattern: "^[a-f0-9]{64}$" }),
                Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
            ]),
            { maxItems: MAX_ENTRIES },
        ),
    },
    { additionalProperties: false },
);

/** Only Pi's structured startup skill catalog, not instructions loaded later into messages. */
export function getSkillPromptSection(prompt: string): string {
    const marker = "<skills>\n";
    const start = prompt.lastIndexOf(marker);
    if (start < 0 || (start > 0 && prompt[start - 1] !== "\n")) return "";

    const end = prompt.indexOf("\n</skills>", start + marker.length);
    if (end < 0) return "";

    const section = prompt.slice(start, end + "\n</skills>".length);
    if (!section.includes("<available_skills>")) return "";
    return section;
}

function defaultCachePath(): string {
    let root = process.env.XDG_CACHE_HOME;
    if (root === undefined || !isAbsolute(root)) root = join(homedir(), ".cache");

    return join(root, "pi-ui-tweaks", "skill-tokens-v1.json");
}

function estimateSection(text: string): number {
    return estimateTokens({ role: "system", content: text, timestamp: 0 });
}

/** Content-addressed, bounded, best-effort cache; no I/O until count() is called. */
export class SkillTokenCache {
    private readonly entries = new Map<string, number>();
    private loaded = false;

    constructor(
        private readonly path = defaultCachePath(),
        private readonly estimate = estimateSection,
    ) {}

    count(section: string): number {
        if (section.length === 0) return 0;

        const key = createHash("sha256")
            .update(`pi-chars-per-four-v1:${VERSION}\0`)
            .update(section)
            .digest("hex");

        this.load();

        const cached = this.entries.get(key);
        if (cached !== undefined) return cached;

        const tokens = this.estimate(section);
        this.entries.set(key, tokens);

        while (this.entries.size > MAX_ENTRIES) {
            const first = this.entries.keys().next();
            if (first.done !== true) this.entries.delete(first.value);
        }

        this.save();

        return tokens;
    }

    private load(): void {
        if (this.loaded) return;

        this.loaded = true;

        try {
            if (statSync(this.path).size > 65536) return;

            const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
            if (!Value.Check(CacheDocument, value)) return;

            for (const [key, tokens] of value.entries) this.entries.set(key, tokens);
        } catch {
            // Optional cache misses, corruption and permissions never prevent startup.
        }
    }

    private save(): void {
        const temporary = `${this.path}.${randomUUID()}.tmp`;

        try {
            mkdirSync(dirname(this.path), { recursive: true });
            writeFileSync(temporary, JSON.stringify({ version: 1, entries: [...this.entries] }), {
                mode: 0o600,
            });

            renameSync(temporary, this.path);
        } catch {
            // Another session may replace the cache; every count remains keyed by exact content.
        } finally {
            try {
                unlinkSync(temporary);
            } catch {
                /* Renamed or never created. */
            }
        }
    }
}

let sharedCache: SkillTokenCache | undefined;

export function getCachedSkillTokens(prompt: string): number {
    sharedCache ??= new SkillTokenCache();
    return sharedCache.count(getSkillPromptSection(prompt));
}
