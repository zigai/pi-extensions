import { Type } from "typebox";
import { Value } from "typebox/value";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

export type Scope = "session" | "project" | "global";

export const scopes: Scope[] = ["session", "project", "global"];
export const scopeLabels = {
    session: "This session",
    project: "This project",
    global: "All projects",
};

export interface Occurrence {
    session: string;
    entry: string;
    timestamp: string;
    cwd: string;
    text: string;
}

export function identity(row: Occurrence): string {
    return JSON.stringify([row.session, row.entry]);
}

export function tokens(query: string): string[] {
    return query.toLowerCase().split(/\s+/u).filter(Boolean);
}

export function matching(rows: readonly Occurrence[], query: string): Occurrence[] {
    const terms = tokens(query);
    const seen = new Set<string>();

    return [...rows]
        .sort(
            (a, b) =>
                b.timestamp.localeCompare(a.timestamp) ||
                b.session.localeCompare(a.session) ||
                b.entry.localeCompare(a.entry),
        )
        .filter((row) => {
            const copy = row.text.toLowerCase().replace(/\s+/gu, " ");

            if (!terms.every((term) => copy.includes(term)) || seen.has(row.text)) return false;

            seen.add(row.text);

            return true;
        });
}

async function gitRoot(cwd: string): Promise<string> {
    return new Promise((resolveRoot, reject) => {
        execFile(
            "git",
            ["-C", cwd, "rev-parse", "--show-toplevel"],
            { timeout: 1500, maxBuffer: 1024 * 1024 },
            (error, stdout) => {
                if (error) {
                    reject(new Error("Git identity unavailable"));
                    return;
                }

                let root = stdout;
                if (root.endsWith("\n")) root = root.slice(0, -1);
                resolveRoot(root);
            },
        );
    });
}

export class ProjectIdentity {
    private readonly cache = new Map<string, Promise<string>>();

    async resolve(cwd: string): Promise<string> {
        let pending = this.cache.get(cwd);
        if (!pending) {
            pending = this.lookup(cwd);
            this.cache.set(cwd, pending);
        }

        return pending;
    }

    private async lookup(cwd: string): Promise<string> {
        const fallback = resolve(cwd);
        let canonical: string;
        try {
            canonical = await realpath(fallback);
        } catch {
            return fallback;
        }

        try {
            return await realpath(await gitRoot(canonical));
        } catch {
            return canonical;
        }
    }
}

const textBlock = Type.Object({ type: Type.Literal("text"), text: Type.String() });
const userEntry = Type.Object({
    type: Type.Literal("message"),
    id: Type.Optional(Type.String()),
    timestamp: Type.Optional(Type.String()),
    message: Type.Object({
        role: Type.Literal("user"),
        content: Type.Union([Type.String(), Type.Array(Type.Unknown())]),
    }),
});

const headerSchema = Type.Object({
    type: Type.Literal("session"),
    id: Type.String(),
    cwd: Type.String({ minLength: 1 }),
});

/** Validate unknown persisted data at the boundary; never search assistant/tool payloads. */
export function extract(entries: readonly unknown[], session: string, cwd: string): Occurrence[] {
    const rows: Occurrence[] = [];
    for (const [index, entry] of entries.entries()) {
        if (!Value.Check(userEntry, entry)) continue;

        const content = entry.message.content;
        let text = "";
        if (Value.Check(Type.String(), content)) text = content;
        else
            text = content
                .filter((block) => Value.Check(textBlock, block))
                .map((block) => block.text)
                .join("");

        if (!text.trim()) continue;

        let timestamp = "1970-01-01T00:00:00.000Z";
        if (entry.timestamp !== undefined && Number.isFinite(Date.parse(entry.timestamp)))
            timestamp = new Date(entry.timestamp).toISOString();

        rows.push({ session, entry: entry.id ?? String(index), timestamp, cwd, text });
    }

    return rows;
}

export function parseTranscript(content: string): Occurrence[] {
    const entries: unknown[] = [];
    for (const line of content.split(/\r?\n/u)) {
        if (!line.trim()) continue;

        const parsed: unknown = JSON.parse(line);
        entries.push(parsed);
    }

    const header = entries[0];
    if (!Value.Check(headerSchema, header)) throw new Error("Invalid session header");
    return extract(entries, header.id, header.cwd);
}
