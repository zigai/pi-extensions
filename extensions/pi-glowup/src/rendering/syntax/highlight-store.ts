import { createHash } from "node:crypto";
import {
    mkdir,
    readdir,
    readFile,
    rename,
    stat,
    unlink,
    utimes,
    writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const STORE_FORMAT = "1";
const ENTRY_SUFFIX = ".json";
const MAX_STORED_ENTRIES = 4000;
const PRUNED_STORED_ENTRIES = 3000;
const MAX_STORED_BYTES = 64 * 1024 * 1024;
const PRUNED_STORED_BYTES = 48 * 1024 * 1024;
const MAX_STORED_ENTRY_BYTES = 512 * 1024;
const WRITES_BETWEEN_PRUNES = 200;

/** Tokenizer results kept across sessions, keyed by everything that can change them. */
export type SyntaxHighlightStore = {
    readonly read: (key: SyntaxHighlightKey) => Promise<string | undefined>;
    readonly write: (key: SyntaxHighlightKey, value: string) => void;
};

export type SyntaxHighlightKey = {
    /** Operation, language, theme, options, and source as one stable string. */
    readonly input: string;

    /** Files whose path, size, and modification time are part of the key. */
    readonly files: readonly string[];
};

type StoreFailureReporter = (message: string) => void;

type StoredEntry = {
    readonly path: string;
    readonly modified: number;
    readonly size: number;
};

function isMissingFile(cause: unknown): boolean {
    if (!(cause instanceof Error) || !("code" in cause)) return false;

    return cause.code === "ENOENT" || cause.code === "ENOTDIR";
}

async function fileIdentity(path: string): Promise<string | undefined> {
    try {
        const info = await stat(path);
        if (!info.isFile()) return undefined;

        return `${path}\0${info.size}\0${info.mtimeMs}`;
    } catch (cause: unknown) {
        if (isMissingFile(cause)) return undefined;

        throw cause;
    }
}

async function storedEntry(path: string): Promise<StoredEntry | undefined> {
    try {
        const info = await stat(path);
        return { path, modified: info.mtimeMs, size: info.size };
    } catch (cause: unknown) {
        if (isMissingFile(cause)) return undefined;

        throw cause;
    }
}

async function removeEntry(path: string): Promise<void> {
    try {
        await unlink(path);
    } catch (cause: unknown) {
        if (!isMissingFile(cause)) throw cause;
    }
}

export function createSyntaxHighlightStore(
    directory: string,
    reportFailure: StoreFailureReporter,
): SyntaxHighlightStore {
    // Rebuilding Glowup can change how tokens become terminal colors.
    const codeFile = fileURLToPath(import.meta.url);
    const identities = new Map<string, Promise<string | undefined>>();
    let reported = false;
    let prepared: Promise<void> | undefined;
    let writes = 0;

    const report = (cause: unknown): void => {
        if (reported) return;

        reported = true;

        let reason = String(cause);
        if (cause instanceof Error) reason = cause.message;
        reportFailure(`[pi-glowup] Syntax highlight cache is unavailable: ${reason}`);
    };

    const identityOf = async (path: string): Promise<string | undefined> => {
        let identity = identities.get(path);
        if (identity === undefined) {
            identity = fileIdentity(path);
            identities.set(path, identity);
        }

        return identity;
    };

    const fileFor = async (key: SyntaxHighlightKey): Promise<string | undefined> => {
        const files = await Promise.all([codeFile, ...key.files].map(identityOf));
        const hash = createHash("sha256").update(STORE_FORMAT);
        for (const identity of files) {
            if (identity === undefined) return undefined;

            hash.update("\0").update(identity);
        }

        const name = hash.update("\0").update(key.input).digest("hex");
        return join(directory, `${name}${ENTRY_SUFFIX}`);
    };

    const prune = async (): Promise<void> => {
        const names = (await readdir(directory)).filter((name) => name.endsWith(ENTRY_SUFFIX));
        const entries = await Promise.all(
            names.map(async (name) => storedEntry(join(directory, name))),
        );
        const present = entries.filter((entry) => entry !== undefined);
        let bytes = 0;
        for (const entry of present) bytes += entry.size;

        if (present.length <= MAX_STORED_ENTRIES && bytes <= MAX_STORED_BYTES) return;

        present.sort((left, right) => left.modified - right.modified);

        let count = present.length;
        for (const entry of present) {
            if (count <= PRUNED_STORED_ENTRIES && bytes <= PRUNED_STORED_BYTES) break;

            await removeEntry(entry.path);
            count -= 1;
            bytes -= entry.size;
        }
    };

    const store = async (key: SyntaxHighlightKey, value: string): Promise<void> => {
        const path = await fileFor(key);
        if (path === undefined) return;

        prepared ??= mkdir(directory, { recursive: true }).then(prune);
        await prepared;

        // Another session may read the same entry; it sees either nothing or all of it.
        const partial = `${path}.${process.pid}.${writes}.partial`;

        writes += 1;

        try {
            await writeFile(partial, value, { mode: 0o600 });
            await rename(partial, path);
        } catch (cause: unknown) {
            await removeEntry(partial);
            throw cause;
        }

        if (writes % WRITES_BETWEEN_PRUNES === 0) await prune();
    };

    const touch = async (path: string): Promise<void> => {
        const now = new Date();
        try {
            await utimes(path, now, now);
        } catch (cause: unknown) {
            if (!isMissingFile(cause)) throw cause;
        }
    };

    return {
        async read(key) {
            try {
                const path = await fileFor(key);
                if (path === undefined) return undefined;

                const value = await readFile(path, "utf8");

                // Pruning removes the least recently used entries first.
                void touch(path).catch(report);

                return value;
            } catch (cause: unknown) {
                if (!isMissingFile(cause)) report(cause);

                return undefined;
            }
        },
        write(key, value) {
            if (Buffer.byteLength(value, "utf8") > MAX_STORED_ENTRY_BYTES) return;

            void store(key, value).catch(report);
        },
    };
}
