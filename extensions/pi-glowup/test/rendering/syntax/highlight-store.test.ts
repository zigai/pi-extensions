import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { ThemeRegistration } from "shiki";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { buildPierreDiffPayload } from "../../../src/rendering/diff/payload.ts";
import { createSyntaxHighlightStore } from "../../../src/rendering/syntax/highlight-store.ts";
import { loadSyntaxConfig, loadSyntaxTheme } from "../../../src/rendering/syntax/theme-loader.ts";
import { createSyntaxTokenizer } from "../../../src/rendering/syntax/tokenizer.ts";

const SOURCE = "const answer = compute(42);\nexport { answer };";

let theme: ThemeRegistration;
const directories: string[] = [];
const tokenizers: Array<ReturnType<typeof createSyntaxTokenizer>> = [];

beforeAll(async () => {
    const loaded = await loadSyntaxTheme(loadSyntaxConfig({}));
    if (loaded === undefined) throw new Error("Missing bundled syntax theme");

    theme = loaded.registration;
});

afterEach(async () => {
    await Promise.allSettled(tokenizers.splice(0).map(async (tokenizer) => tokenizer.dispose()));
    await Promise.all(
        directories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })),
    );
});

async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "glowup-highlight-store-"));
    directories.push(path);
    return path;
}

function tokenizerWithStore(directory: string, warning: (message: string) => void = () => {}) {
    const started: Worker[] = [];
    const tokenizer = createSyntaxTokenizer(theme, {
        maxJobs: 8,
        maxBytes: 1024 * 1024,
        reportWarning: undefined,
        waitForDisposals: async () => {},
        createWorker: (url) => {
            const worker = new Worker(url, { execArgv: [] });
            started.push(worker);
            return worker;
        },
        store: createSyntaxHighlightStore(directory, warning),
    });
    tokenizers.push(tokenizer);

    return { tokenizer, started };
}

async function storedEntries(directory: string): Promise<string[]> {
    try {
        return (await readdir(directory)).filter((name) => name.endsWith(".json"));
    } catch {
        return [];
    }
}

function diffMetadata() {
    const oldContent = "const value = call(1);\n";
    const newContent = "const value = call(2);\n";
    const payload = buildPierreDiffPayload({
        path: "src/value.ts",
        oldContent,
        newContent,
        oldSizeBytes: oldContent.length,
        newSizeBytes: newContent.length,
        canBuildPierreDiff: true,
    });
    if (payload?.kind !== "renderable") throw new Error("expected renderable payload");

    return payload.metadata;
}

it("serves a later session's identical requests from disk without starting a worker", async () => {
    const directory = await temporaryDirectory();
    const first = tokenizerWithStore(directory);
    const lines = await first.tokenizer.tokenize(SOURCE, "typescript", true);
    const diff = await first.tokenizer.highlightDiff(diffMetadata());
    expect(lines?.join("\n")).toContain("\u001b[38;2;");
    expect(diff?.highlight).toBeDefined();
    await vi.waitFor(async () => expect(await storedEntries(directory)).toHaveLength(2));

    const second = tokenizerWithStore(directory);
    expect(await second.tokenizer.tokenize(SOURCE, "typescript", true)).toEqual(lines);
    expect(await second.tokenizer.highlightDiff(diffMetadata())).toEqual(diff);
    expect(second.started).toHaveLength(0);

    const changed = await second.tokenizer.tokenize(`${SOURCE}\n// changed`, "typescript", true);
    expect(changed).toHaveLength(3);
    expect(second.started).toHaveLength(1);

    const plainBrackets = await second.tokenizer.tokenize(SOURCE, "typescript", false);
    expect(plainBrackets).toHaveLength(2);
    await vi.waitFor(async () => expect(await storedEntries(directory)).toHaveLength(4));
});

it("highlights through the worker when a stored entry is corrupt", async () => {
    const directory = await temporaryDirectory();
    const first = tokenizerWithStore(directory);
    const lines = await first.tokenizer.tokenize(SOURCE, "typescript", true);
    await vi.waitFor(async () => expect(await storedEntries(directory)).toHaveLength(1));

    const [entry] = await storedEntries(directory);
    if (entry === undefined) throw new Error("missing stored entry");

    await writeFile(join(directory, entry), "{not json");

    const second = tokenizerWithStore(directory);
    expect(await second.tokenizer.tokenize(SOURCE, "typescript", true)).toEqual(lines);
    expect(second.started).toHaveLength(1);
});

it.each([
    ["lines with a non-string row", "lines", '["const", 1]'],
    [
        "lines stored as a diff",
        "lines",
        '{"dark":{"colors":[],"deletionLines":[],"additionLines":[]},"light":null}',
    ],
    [
        "a diff with fractional runs",
        "diff",
        '{"dark":{"colors":["#fff"],"deletionLines":[["a",[0.5,0,0]]],"additionLines":[]},"light":null}',
    ],
    [
        "a diff line without runs",
        "diff",
        '{"dark":{"colors":[],"deletionLines":[["a"]],"additionLines":[]},"light":null}',
    ],
    [
        "a diff with a malformed light side",
        "diff",
        '{"dark":{"colors":[],"deletionLines":[],"additionLines":[]},"light":{"colors":[]}}',
    ],
    ["a diff stored as lines", "diff", '["const"]'],
])("highlights through the worker when a stored entry holds %s", async (_name, kind, stored) => {
    const directory = await temporaryDirectory();
    const first = tokenizerWithStore(directory);
    const highlight = async (tokenizer: ReturnType<typeof createSyntaxTokenizer>) => {
        if (kind === "lines") return tokenizer.tokenize(SOURCE, "typescript", true);
        return tokenizer.highlightDiff(diffMetadata());
    };

    const expected = await highlight(first.tokenizer);
    await vi.waitFor(async () => expect(await storedEntries(directory)).toHaveLength(1));

    const [entry] = await storedEntries(directory);
    if (entry === undefined) throw new Error("missing stored entry");

    await writeFile(join(directory, entry), stored);

    const second = tokenizerWithStore(directory);
    expect(await highlight(second.tokenizer)).toEqual(expected);
    expect(second.started).toHaveLength(1);
});

it("keeps highlighting and reports once when the cache directory is unusable", async () => {
    const parent = await temporaryDirectory();
    const blocked = join(parent, "not-a-directory");
    await writeFile(blocked, "");
    const warning = vi.fn<(message: string) => void>();
    const { tokenizer } = tokenizerWithStore(join(blocked, "cache"), warning);

    for (const suffix of ["a", "b", "c"]) {
        const lines = await tokenizer.tokenize(`${SOURCE}\n// ${suffix}`, "typescript", true);
        expect(lines?.join("\n")).toContain("\u001b[38;2;");
    }

    await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
    });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[0]).toContain("Syntax highlight cache is unavailable");
});

it("prunes the oldest entries once the store exceeds its entry bound", async () => {
    const directory = await temporaryDirectory();
    const old = new Date(Date.now() - 60_000);
    const names = Array.from({ length: 4100 }, (_value, index) => `old-${index}.json`);
    await Promise.all(
        names.map(async (name) => {
            const path = join(directory, name);
            await writeFile(path, "[]");
            await utimes(path, old, old);
        }),
    );

    const { tokenizer } = tokenizerWithStore(directory);
    await tokenizer.tokenize(SOURCE, "typescript", true);

    await vi.waitFor(async () => {
        const entries = await storedEntries(directory);
        expect(entries.length).toBeLessThanOrEqual(3001);
        expect(entries.filter((name) => !name.startsWith("old-"))).toHaveLength(1);
    });
});
