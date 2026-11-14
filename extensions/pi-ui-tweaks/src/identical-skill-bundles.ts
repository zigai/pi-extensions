import {
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    openSync,
    opendirSync,
    readSync,
    realpathSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

// Shared by all comparisons in one presentation pass, not a persistent equality cache.
export type SkillComparisonBudget = { entries: number; bytes: number };

export function skillComparisonBudget(): SkillComparisonBudget {
    return { entries: 2048, bytes: 16 * 1024 * 1024 };
}

type BundleEntry = { bytes?: Buffer; executable: number };

function readBundle(root: string, budget: SkillComparisonBudget): Map<string, BundleEntry> {
    const entries = new Map<string, BundleEntry>();
    const walk = (relative: string, depth: number): void => {
        if (depth > 16 || --budget.entries < 0) throw new Error("Skill comparison entry limit");

        const path = join(root, relative);
        const stat = lstatSync(path);

        // Root aliases are resolved before traversal. Never follow nested symlinks,
        // special files, or directories/files without ordinary read permissions.
        if ((stat.mode & 0o444) === 0) throw new Error("Unreadable skill entry");

        if (stat.isDirectory()) {
            if ((stat.mode & 0o111) === 0) throw new Error("Unsearchable skill directory");

            entries.set(relative, { executable: stat.mode & 0o111 });

            const dir = opendirSync(path);

            try {
                for (let child = dir.readSync(); child !== null; child = dir.readSync()) {
                    walk(join(relative, child.name), depth + 1);
                }
            } finally {
                dir.closeSync();
            }
        } else if (stat.isFile()) {
            if (stat.size > budget.bytes) throw new Error("Skill comparison byte limit");

            budget.bytes -= stat.size;

            const fd = openSync(
                path,
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );

            try {
                const before = fstatSync(fd);
                if (
                    !before.isFile() ||
                    before.ino !== stat.ino ||
                    before.dev !== stat.dev ||
                    before.size !== stat.size
                )
                    throw new Error("Skill changed during comparison");

                const bytes = Buffer.alloc(stat.size);
                let offset = 0;
                while (offset < bytes.length) {
                    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
                    if (count === 0) throw new Error("Short skill read");

                    offset += count;
                }

                const after = fstatSync(fd);
                if (
                    readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0 ||
                    before.size !== after.size ||
                    before.mtimeMs !== after.mtimeMs ||
                    before.ctimeMs !== after.ctimeMs
                )
                    throw new Error("Skill changed during comparison");

                entries.set(relative, { bytes, executable: stat.mode & 0o111 });
            } finally {
                closeSync(fd);
            }
        } else {
            throw new Error("Unsafe skill entry");
        }

        const after = lstatSync(path);
        if (
            stat.ino !== after.ino ||
            stat.dev !== after.dev ||
            stat.mtimeMs !== after.mtimeMs ||
            stat.ctimeMs !== after.ctimeMs
        )
            throw new Error("Skill changed during comparison");
    };

    walk("", 0);

    return entries;
}

/** Equality is proven only for bounded, readable SKILL.md directory bundles. */
export function identicalSkillBundles(
    winnerPath: string,
    loserPath: string,
    budget: SkillComparisonBudget,
): boolean {
    // Loose Markdown skills share a parent with unrelated skills; leave those warnings alone.
    if (basename(winnerPath) !== "SKILL.md" || basename(loserPath) !== "SKILL.md") return false;
    if (budget.entries <= 0) return false;

    try {
        const winner = readBundle(realpathSync(dirname(winnerPath)), budget);
        const loser = readBundle(realpathSync(dirname(loserPath)), budget);
        if (
            !winner.get("SKILL.md")?.bytes ||
            !loser.get("SKILL.md")?.bytes ||
            winner.size !== loser.size
        )
            return false;

        for (const [path, entry] of winner) {
            const other = loser.get(path);
            if (other === undefined || entry.executable !== other.executable) return false;

            if (entry.bytes === undefined) {
                if (other.bytes !== undefined) return false;
            } else if (other.bytes === undefined || !entry.bytes.equals(other.bytes)) return false;
        }

        return true;
    } catch {
        // Missing files, unreadable content, unsafe entries and exhausted budgets preserve warnings.
        return false;
    }
}
