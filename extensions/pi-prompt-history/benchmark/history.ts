import { setImmediate as nextJob } from "node:timers/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matching, type Occurrence } from "../src/search.ts";
import { HistorySource } from "../src/source.ts";
import { HistoryIndex } from "../src/history-index.ts";

// Run each mode/variant in a fresh --expose-gc process. Baseline is the saved checkout, not HEAD.
async function collect(): Promise<void> {
    for (let index = 0; index < 3; index++) {
        await nextJob();
        global.gc?.();
    }
}

const variant = process.argv[2] ?? "after";
const mode = process.argv[3] ?? "queries";

interface Engine {
    update(rows: readonly Occurrence[]): void;
    query(query: string): Occurrence[];
}

let engine: Engine;
if (variant === "before") {
    engine = new (class implements Engine {
        private rows: readonly Occurrence[] = [];

        update(rows: readonly Occurrence[]): void {
            this.rows = rows;
        }

        query(query: string): Occurrence[] {
            return matching(this.rows, query);
        }
    })();
} else {
    engine = new HistoryIndex();
}

const rows: Occurrence[] = Array.from({ length: 50_000 }, (_, i) => ({
    session: `session-${i % 500}`,
    entry: String(i),
    cwd: "/fixture",
    timestamp: new Date(1_700_000_000_000 + ((i * 7919) % 50_000) * 1000).toISOString(),
    text: `Prompt ${i % 45_000} for topic ${i % 97}\nwith Unicode 🦊 and literal [.*]`,
}));

const queries = [
    "",
    "p",
    "pr",
    "prompt",
    "prompt 1",
    "topic 2",
    "🦊",
    "literal [.*]",
    "absent",
    "topic 96",
];

let directory: string | undefined;
if (mode === "scan" || mode === "scan-only") {
    directory = await mkdtemp(join(tmpdir(), "pi-history-bench-"));
    await mkdir(join(directory, "sessions"));

    for (let file = 0; file < 500; file++) {
        const lines: unknown[] = [{ type: "session", id: `file-${file}`, cwd: directory }];
        for (const row of rows.slice(file * 100, file * 100 + 100))
            lines.push({
                type: "message",
                id: row.entry,
                timestamp: row.timestamp,
                message: { role: "user", content: row.text },
            });

        await writeFile(
            join(directory, "sessions", `${file}.jsonl`),
            lines.map((line) => JSON.stringify(line)).join("\n"),
        );
    }
}

if (global.gc === undefined) throw new Error("Use node --expose-gc");

await collect();

const heapBefore = process.memoryUsage().heapUsed;
const cpuBefore = process.cpuUsage();
const started = performance.now();
let checksum = 0;
let notifications = 0;
let ingestionWallMs = 0;
let scanRows: readonly Occurrence[] = [];

if (mode === "queries" || mode === "cold-query") {
    const ingestStarted = performance.now();

    engine.update(rows);
    ingestionWallMs = performance.now() - ingestStarted;

    let queryCount = 100;
    if (mode === "cold-query") queryCount = 1;

    for (let i = 0; i < queryCount; i++)
        checksum += engine.query(queries[i % queries.length] ?? "").length;
} else if (mode === "ingestion") {
    for (let i = 1; i <= 100; i++) {
        const ingestStarted = performance.now();

        engine.update(rows.slice(0, i * 500));
        ingestionWallMs += performance.now() - ingestStarted;
        checksum += engine.query("topic 2").length;
    }
} else if ((mode === "scan" || mode === "scan-only") && directory !== undefined) {
    const source = new HistorySource({
        root: join(directory, "sessions"),
        session: "live",
        cwd: directory,
        live: () => [],
    });

    await source.scan("global", (snapshot) => {
        notifications++;

        if (mode === "scan-only") {
            scanRows = snapshot.rows;
            checksum = scanRows.length;
        } else {
            const ingestStarted = performance.now();

            engine.update(snapshot.rows);
            ingestionWallMs += performance.now() - ingestStarted;
            checksum = engine.query("topic 2").length;
        }
    });
    source.cancel();
} else throw new Error(`Unknown mode: ${mode}`);

const wallMs = performance.now() - started;
const cpu = process.cpuUsage(cpuBefore);

await collect();

const heapUsedBytes = process.memoryUsage().heapUsed;
const retainedHeapBytes = heapUsedBytes - heapBefore;
const peakRssKiB = process.resourceUsage().maxRSS;
let keptRows = engine.query("").length;
if (mode === "scan-only") keptRows = scanRows.length;

console.log(
    JSON.stringify({
        variant,
        mode,
        wallMs,
        userMs: cpu.user / 1000,
        systemMs: cpu.system / 1000,
        peakRssKiB,
        retainedHeapBytes,
        heapUsedBytes,
        ingestionWallMs,
        keptRows,
        checksum,
        notifications,
    }),
);

if (directory !== undefined) await rm(directory, { recursive: true, force: true });
