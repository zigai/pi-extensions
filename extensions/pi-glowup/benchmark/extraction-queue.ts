// Deterministic queue audit: build isolated instrumented bundles, never swap source or dist.
// node --import tsx benchmark/extraction-queue.ts /tmp/pi-glowup-round3/baseline
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const current = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseline = process.argv[2];
if (baseline === undefined) throw new Error("Pass the baseline extension directory");

const temporary = await mkdtemp(path.join(tmpdir(), "glowup-extraction-"));

try {
    await symlink(
        path.resolve(current, "../../node_modules"),
        path.join(temporary, "node_modules"),
    );

    for (const [label, root] of [
        ["baseline", path.resolve(baseline)],
        ["current", current],
    ]) {
        if (root === undefined) continue;

        const fake = path.join(temporary, `${label}-worker.ts`);
        await writeFile(
            fake,
            `
import { EventEmitter } from 'node:events';
import { extractEmbeddedPrograms } from ${JSON.stringify(path.join(root, "src/tools/built-in/bash/embedded-programs.ts"))};
export const workers = [];
export class Worker extends EventEmitter {
  requests = [];
  constructor() { super(); workers.push(this); }
  ref() {} unref() {} async terminate() { return 0; }
  postMessage(request) { this.requests.push(request); }
  respond() {
    const request = this.requests.shift();
    if (request) this.emit('message', {id:request.id, kind:'embedded', programs:extractEmbeddedPrograms(request.source)});
  }
}
`,
        );

        const entry = path.join(temporary, `${label}-entry.ts`);

        await writeFile(
            entry,
            `
import assert from "node:assert/strict";
import { createStatementService } from ${JSON.stringify(path.join(root, "src/rendering/streaming/statement-service.ts"))};
import { createEmbeddedProgramService } from ${JSON.stringify(path.join(root, "src/tools/built-in/bash/embedded-service.ts"))};
import { extractEmbeddedPrograms } from ${JSON.stringify(path.join(root, "src/tools/built-in/bash/embedded-programs.ts"))};
import { workers } from ${JSON.stringify(fake)};
const module = { createStatementService, createEmbeddedProgramService, extractEmbeddedPrograms, workers };
        async function drain() {
            let completed = 0;
            for (let turn = 0; turn < 3000; turn++) {
                let busy = false;
                for (const worker of module.workers) {
                    if (worker.requests.length > 0) {
                        worker.respond();
                        completed++;
                        busy = true;
                    }
                }
                for (let tick = 0; tick < 8; tick++) await Promise.resolve();
                if (
                    !busy &&
                    module.workers.every(
                        (worker) => worker.requests.length === 0,
                    )
                )
                    return completed;
            }
            throw new Error("Queue did not quiesce");
        }
        const parser = module.createStatementService();
        const requests = Array.from({ length: 1000 }, (_, index) =>
            parser.extract(\`python -c 'print(\${index})'\`, new AbortController().signal),
        );
        const parserBurst = parser.audit();
        await drain();
        const admitted = (await Promise.all(requests)).filter(
            (result) => result !== undefined,
        ).length;
        const recovered = parser.extract("python -c 'print(999)'", new AbortController().signal);
        await drain();
        assert.deepEqual(await recovered, module.extractEmbeddedPrograms("python -c 'print(999)'"));
        await parser.dispose();
        const service = module.createEmbeddedProgramService();
        const sources = Array.from(
            { length: 1000 },
            (_, index) => \`#\${index}\\n#\${"é".repeat(16 * 1024)}\\npython -c 'print(\${index})'\`,
        );
        for (const source of sources) service.get(source);
        const demandBurst = service.audit();
        const completed = await drain();
        await service.settled();
        const latest = sources.at(-1) ?? "";
        assert.deepEqual(service.get(latest), module.extractEmbeddedPrograms(latest));
        const retry = service.resolve(sources[1] ?? "", new AbortController().signal);
        await drain();
        assert.deepEqual(await retry, module.extractEmbeddedPrograms(sources[1] ?? ""));
        const settled = service.audit();
        await service.dispose();
        console.log(
            JSON.stringify({
                label: "${label}",
                parserBurst,
                admitted,
                demandBurst,
                completed,
                settled,
                latestAndRetryExact: true,
            }),
        );
`,
        );

        const outfile = path.join(temporary, `${label}.mjs`);

        await build({
            entryPoints: [entry],
            outfile,
            bundle: true,
            platform: "node",
            format: "esm",
            packages: "external",
            plugins: [
                {
                    name: "queue-audit",
                    setup(builder) {
                        builder.onLoad(
                            { filter: /(?:statement|embedded)-service\.ts$/ },
                            async ({ path: filename }) => {
                                let contents = await readFile(filename, "utf8");
                                if (filename.endsWith("statement-service.ts")) {
                                    contents = contents.replace(
                                        '"node:worker_threads"',
                                        JSON.stringify(fake),
                                    );
                                    contents = contents.replace(
                                        "    return {",
                                        `    return {
 audit: () => ({ jobs: queue.length + Number(active !== undefined), sourceBytes: queue.reduce((sum, job) => sum + Buffer.byteLength(job.request.source), active === undefined ? 0 : Buffer.byteLength(active.request.source)) }),`,
                                    );
                                } else {
                                    contents = contents.replace(
                                        "    return {",
                                        `    return {
 audit: () => ({ entries: entries.size, pending: [...entries.values()].filter(entry => !entry.settled).length, sourceBytes: [...entries.keys()].reduce((sum, source) => sum + Buffer.byteLength(source), 0) }),`,
                                    );
                                }

                                return {
                                    contents,
                                    loader: "ts",
                                    resolveDir: path.dirname(filename),
                                };
                            },
                        );
                    },
                },
            ],
        });
        process.stdout.write(execFileSync(process.execPath, [outfile], { encoding: "utf8" }));
    }
} finally {
    await rm(temporary, { recursive: true, force: true });
}
