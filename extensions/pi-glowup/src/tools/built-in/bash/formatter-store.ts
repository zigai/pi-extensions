import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STORE_FORMAT = "1";
const MAX_STORED_OUTPUTS = 2000;
const PRUNED_STORED_OUTPUTS = 1500;
const MAX_STORED_OUTPUT_BYTES = 256 * 1024;

/** Formatter outputs kept across sessions, keyed by everything that can change them. */
export type FormatterOutputStore = {
    readonly read: (key: FormatterOutputKey) => Promise<string | undefined>;
    readonly write: (key: FormatterOutputKey, output: string) => void;
};

export type FormatterOutputKey = {
    /** Profile settings, language, width, and source as one stable string. */
    readonly input: string;

    /** The program the profile runs; its file identity is part of the key. */
    readonly executable: string;
};

type StoreFailureReporter = (message: string) => void;

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

async function executableIdentity(executable: string): Promise<string | undefined> {
    if (isAbsolute(executable) || executable.includes("/"))
        return fileIdentity(resolve(executable));

    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
        if (directory.length === 0) continue;

        const identity = await fileIdentity(join(directory, executable));
        if (identity !== undefined) return identity;
    }

    return undefined;
}

export function createFormatterOutputStore(
    directory: string,
    reportFailure: StoreFailureReporter,
): FormatterOutputStore {
    // Rebuilding Glowup can change how formatter output is post-processed.
    const codeIdentity = fileIdentity(fileURLToPath(import.meta.url));
    const executables = new Map<string, Promise<string | undefined>>();
    let reported = false;
    let prepared: Promise<void> | undefined;
    let writes = 0;

    const report = (cause: unknown): void => {
        if (reported) return;

        reported = true;

        let reason = String(cause);
        if (cause instanceof Error) reason = cause.message;
        reportFailure(`[pi-glowup] Formatter output cache is unavailable: ${reason}`);
    };

    const fileFor = async (key: FormatterOutputKey): Promise<string | undefined> => {
        let executable = executables.get(key.executable);
        if (executable === undefined) {
            executable = executableIdentity(key.executable);
            executables.set(key.executable, executable);
        }

        const [code, program] = await Promise.all([codeIdentity, executable]);
        if (code === undefined || program === undefined) return undefined;

        const name = createHash("sha256")
            .update(STORE_FORMAT)
            .update("\0")
            .update(code)
            .update("\0")
            .update(program)
            .update("\0")
            .update(process.cwd())
            .update("\0")
            .update(key.input)
            .digest("hex");

        return join(directory, `${name}.txt`);
    };

    const prune = async (): Promise<void> => {
        const names = (await readdir(directory)).filter((name) => name.endsWith(".txt"));
        if (names.length <= MAX_STORED_OUTPUTS) return;

        const entries = await Promise.all(
            names.map(async (name) => {
                const path = join(directory, name);
                try {
                    return { path, modified: (await stat(path)).mtimeMs };
                } catch (cause: unknown) {
                    if (isMissingFile(cause)) return undefined;

                    throw cause;
                }
            }),
        );
        const present = entries.filter((entry) => entry !== undefined);

        present.sort((left, right) => left.modified - right.modified);

        for (const entry of present.slice(0, present.length - PRUNED_STORED_OUTPUTS)) {
            await unlink(entry.path).catch((cause: unknown) => {
                if (!isMissingFile(cause)) throw cause;
            });
        }
    };

    const store = async (key: FormatterOutputKey, output: string): Promise<void> => {
        const path = await fileFor(key);
        if (path === undefined) return;

        prepared ??= mkdir(directory, { recursive: true }).then(prune);
        await prepared;

        // Another session may read the same entry; it sees either nothing or all of it.
        const partial = `${path}.${process.pid}.${writes}.partial`;

        writes += 1;
        await writeFile(partial, output, { mode: 0o600 });
        await rename(partial, path);

        if (writes % 200 === 0) await prune();
    };

    return {
        async read(key) {
            try {
                const path = await fileFor(key);
                if (path === undefined) return undefined;

                return await readFile(path, "utf8");
            } catch (cause: unknown) {
                if (!isMissingFile(cause)) report(cause);

                return undefined;
            }
        },
        write(key, output) {
            if (Buffer.byteLength(output, "utf8") > MAX_STORED_OUTPUT_BYTES) return;

            void store(key, output).catch(report);
        },
    };
}
