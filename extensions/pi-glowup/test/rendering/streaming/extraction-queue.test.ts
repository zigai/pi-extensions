import { stripVTControlCharacters } from "node:util";
import { Theme } from "@earendil-works/pi-coding-agent";
import {
    renderBashCommandCall,
    type BashCommandRenderOptions,
} from "../../../src/tools/built-in/bash/renderer.ts";
import { TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS } from "../../support/theme-colors.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerRequest } from "../../../src/rendering/streaming/statement-worker.ts";
import { extractEmbeddedPrograms } from "../../../src/tools/built-in/bash/embedded-programs.ts";

import { EventEmitter } from "node:events";
import { createStatementService as statementService } from "../../../src/rendering/streaming/statement-service.ts";
import { createEmbeddedProgramService as embeddedService } from "../../../src/tools/built-in/bash/embedded-service.ts";

const workers = { instances: new Array<FakeWorker>() };

class FakeWorker extends EventEmitter {
    requests: WorkerRequest[] = [];

    constructor() {
        super();
        workers.instances.push(this);
    }

    postMessage(request: WorkerRequest): void {
        this.requests.push(request);
    }

    ref(): void {}

    unref(): void {}

    async terminate(): Promise<number> {
        return 0;
    }

    respond(): void {
        const request = this.requests.shift();
        if (request === undefined) return;

        if ("kind" in request) {
            this.emit("message", {
                id: request.id,
                kind: "embedded",
                programs: extractEmbeddedPrograms(request.source),
            });
        } else {
            this.emit("message", { id: request.id, units: [], malformed: false });
        }
    }
}

function createStatementService() {
    return statementService(() => new FakeWorker());
}

function createEmbeddedProgramService() {
    return embeddedService(createStatementService());
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    workers.instances.length = 0;
});
async function drain(): Promise<number> {
    let count = 0;
    for (let index = 0; index < 2000; index++) {
        let responded = false;
        for (const worker of workers.instances) {
            if (worker.requests.length > 0) {
                worker.respond();
                responded = true;
                count++;
            }
        }

        for (let tick = 0; tick < 8; tick++) await Promise.resolve();

        if (!responded && workers.instances.every((worker) => worker.requests.length === 0))
            return count;
    }

    throw new Error("extraction did not quiesce");
}

describe("bounded extraction demand", () => {
    it("caps combined parse/extract admission at 300 jobs and permits retry", async () => {
        const service = createStatementService();
        cleanups.push(async () => service.dispose());
        const signal = new AbortController().signal;
        const jobs = Array.from({ length: 300 }, async (_, index) =>
            service.extract(`echo ${index}`, signal),
        );
        let rejected = false;
        const overflow = service.extract("echo overflow", signal).then((value) => {
            rejected = value === undefined;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(rejected).toBe(true);
        expect(await drain()).toBe(300);
        await Promise.all([...jobs, overflow]);
        const retry = service.extract("python -c 'print(42)'", signal);
        await drain();
        expect(await retry).toEqual(extractEmbeddedPrograms("python -c 'print(42)'"));
    });

    it("accounts UTF-8 bytes, including cancelled active worker sources", async () => {
        const service = createStatementService();
        cleanups.push(async () => service.dispose());
        const controller = new AbortController();
        const source = "é".repeat(2 * 1024 * 1024);
        const active = service.extract(source, controller.signal);
        controller.abort();
        expect(await active).toBeUndefined();
        let rejected = false;
        const overflow = service
            .extract("echo next", new AbortController().signal)
            .then((value) => {
                rejected = value === undefined;
            });
        await Promise.resolve();
        await Promise.resolve();
        expect(rejected).toBe(true);
        workers.instances[0]?.emit("message", { id: 1, kind: "embedded", programs: [] });
        await overflow;
        const retry = service.extract("echo next", new AbortController().signal);
        await drain();
        expect(await retry).toEqual([]);
    });

    it("bounds pending demand, retains the latest preview and retries evicted demand", async () => {
        const service = createEmbeddedProgramService();
        cleanups.push(async () => service.dispose());

        for (let index = 0; index < 1000; index++) service.get(`python -c 'print(${index})'`);
        const source = "python -c 'print(999)'";
        const invalidated = vi.fn<() => void>();
        service.get(source, invalidated);
        expect(await drain()).toBeLessThanOrEqual(300);
        await service.settled();
        expect(service.get(source)).toEqual(extractEmbeddedPrograms(source));
        expect(invalidated).toHaveBeenCalledTimes(1);
        const evicted = "python -c 'print(1)'";
        const retry = service.resolve(evicted, new AbortController().signal);
        await drain();
        expect(await retry).toEqual(extractEmbeddedPrograms(evicted));
    });

    it("refreshes existing pending demand instead of losing the latest requested preview", async () => {
        const service = createEmbeddedProgramService();
        cleanups.push(async () => service.dispose());
        service.get("echo active");
        const source = "python -c 'print(1)'";
        service.get(source);

        for (let index = 2; index < 300; index++) service.get(`echo ${index}`);
        const notify = vi.fn<() => void>();
        service.get(source, notify);
        service.get("echo overflow");
        await drain();
        await service.settled();
        expect(service.get(source)).toEqual(extractEmbeddedPrograms(source));
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it("redraws the latest overloaded preview identically to cold extraction", async () => {
        const service = createEmbeddedProgramService();
        cleanups.push(async () => service.dispose());

        for (let index = 0; index < 1000; index++) service.get(`echo ${index}`);
        const command = "echo ready; python <<'PY'\nprint(42)\nprint('RECOVERED_PREVIEW')\nPY";
        const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");
        const invalidate = vi.fn<() => void>();
        const options = {
            state: "success",
            expanded: false,
            maxCodePreviewLines: 8,
            showPrologueOmission: true,
            shellLayout: "auto",
            shellOperatorPosition: "trailing",
            invalidate,
            embeddedPrograms: service.get,
        } satisfies BashCommandRenderOptions;
        const component = renderBashCommandCall(theme, command, options);
        component.render(60);
        await drain();
        await service.settled();
        expect(invalidate).toHaveBeenCalled();
        const cold = renderBashCommandCall(theme, command, {
            ...options,
            embeddedPrograms: () => extractEmbeddedPrograms(command),
        });
        for (const width of [60, 24, 180, 60]) {
            const recovered = component.render(width);
            expect(recovered).toEqual(cold.render(width));
            if (width === 60)
                expect(recovered.map(stripVTControlCharacters).join("\n")).toContain(
                    "RECOVERED_PREVIEW",
                );
        }
    });

    it("bounds retained source bytes and does not lose latest large demand", async () => {
        const service = createEmbeddedProgramService();
        cleanups.push(async () => service.dispose());
        const sources = Array.from(
            { length: 20 },
            (_, index) => `#${index}\n#${"é".repeat(512 * 1024)}\npython -c 'print(${index})'`,
        );
        for (const source of sources) service.get(source);
        expect(await drain()).toBeLessThanOrEqual(7);
        await service.settled();
        const latest = sources.at(-1) ?? "";
        expect(service.get(latest)).toEqual(extractEmbeddedPrograms(latest));
    });

    it("preserves extraction for a single source larger than the competing byte budget", async () => {
        const service = createEmbeddedProgramService();
        cleanups.push(async () => service.dispose());
        const source = `#${"x".repeat(4 * 1024 * 1024)}\npython -c 'print(42)'`;
        const latest = service.resolve(source, new AbortController().signal);
        await drain();
        expect(await latest).toEqual(extractEmbeddedPrograms(source));
        expect(service.get(source)).toEqual(extractEmbeddedPrograms(source));
    });

    it("clears pending generations, settles eviction waiters and disposes without loops", async () => {
        const service = createEmbeddedProgramService();
        cleanups.push(async () => service.dispose());
        service.get("python -c 'print(0)'");
        const old = service.resolve("python -c 'print(1)'", new AbortController().signal);
        service.clear();
        expect(await old).toBeUndefined();
        const latest = service.resolve("python -c 'print(2)'", new AbortController().signal);
        await drain();
        expect(await latest).toEqual(extractEmbeddedPrograms("python -c 'print(2)'"));
        service.get("python -c 'print(3)'");
        await service.dispose();
        await service.settled();
    });
});
