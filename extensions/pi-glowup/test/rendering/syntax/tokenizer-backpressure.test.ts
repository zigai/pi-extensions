import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { createSyntaxTokenizer } from "../../../src/rendering/syntax/tokenizer.ts";

function tokenizer() {
    return createSyntaxTokenizer(undefined, {
        maxJobs: 1,
        maxBytes: 1024,
        reportWarning: undefined,
        waitForDisposals: async () => {},
    });
}

function controlledWorker(onStall: () => void): Worker {
    const worker = new Worker(
        `const { parentPort } = require("node:worker_threads");
        parentPort.on("message", (request) => {
            if (request.type === "initialize") parentPort.postMessage({ type: "ready" });
            else if (request.code === "slow") {
                parentPort.postMessage({ type: "ready" });
                parentPort.postMessage({ id: -1, lines: [] });
                while (true) {}
            }
            else parentPort.postMessage({ id: request.id, lines: [request.code] });
        });`,
        { eval: true },
    );
    worker.on("message", (response: { id?: number }) => {
        if (response.id === -1) onStall();
    });

    return worker;
}

it("terminates a stalled job and resumes queued work on a fresh worker", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let running: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
        running = resolve;
    });
    const worker = createSyntaxTokenizer(undefined, {
        maxJobs: 2,
        maxBytes: 1024,
        reportWarning: undefined,
        waitForDisposals: async () => {},
        createWorker: () => controlledWorker(running),
    });
    const unavailable: string[] = [];
    try {
        const slow = worker.compactPython("slow", {
            onUnavailable: (reason, error) => {
                unavailable.push(`${reason}: ${error}`);
            },
        });
        await stalled;
        const short = worker.compactPython("short");
        vi.advanceTimersToNextTimer();
        await new Promise<void>((resolve) => {
            setImmediate(resolve);
        });
        expect(unavailable).toEqual(["timeout: undefined"]);
        expect(await slow).toBeUndefined();
        expect(await short).toEqual(["short"]);
        expect(await worker.compactPython("recovered")).toEqual(["recovered"]);
    } finally {
        await worker.dispose();
        vi.useRealTimers();
    }
});

it("resumes a backpressured request after an oversized stalled job", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let running: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
        running = resolve;
    });
    const worker = createSyntaxTokenizer(undefined, {
        maxJobs: 2,
        maxBytes: 1,
        reportWarning: undefined,
        waitForDisposals: async () => {},
        createWorker: () => controlledWorker(running),
    });
    let resumed: Promise<string[] | undefined> | undefined;
    try {
        const slow = worker.compactPython("slow");
        await stalled;
        expect(
            await worker.compactPython("short", {
                retryWhenCapacityAvailable: () => {
                    resumed = worker.compactPython("short");
                },
            }),
        ).toBeUndefined();

        vi.advanceTimersToNextTimer();
        await Promise.resolve();
        expect(resumed).toBeDefined();
        expect(await slow).toBeUndefined();
        expect(await resumed).toEqual(["short"]);
    } finally {
        await worker.dispose();
        vi.useRealTimers();
    }
});

it("settles running and queued jobs on shutdown without restarting", async () => {
    let running: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
        running = resolve;
    });
    const worker = createSyntaxTokenizer(undefined, {
        maxJobs: 2,
        maxBytes: 1024,
        reportWarning: undefined,
        waitForDisposals: async () => {},
        createWorker: () => controlledWorker(running),
    });
    const reasons: string[] = [];
    try {
        const slow = worker.compactPython("slow", {
            onUnavailable: (reason) => {
                reasons.push(reason);
            },
        });
        await stalled;
        const queued = worker.compactPython("short", {
            onUnavailable: (reason) => {
                reasons.push(reason);
            },
        });
        await worker.dispose();
        expect(await slow).toBeUndefined();
        expect(await queued).toBeUndefined();
        expect(reasons).toEqual(["cancelled", "cancelled"]);
        expect(await worker.compactPython("later")).toBeUndefined();
    } finally {
        await worker.dispose();
    }
});

it("coalesces repeated capacity requests for one owner", async () => {
    const worker = tokenizer();
    let retries = 0;
    const retryWhenCapacityAvailable = () => {
        retries += 1;
    };
    try {
        const occupied = worker.compactPython("first = 1");
        const rejected = await Promise.all(
            Array.from({ length: 20 }, () =>
                worker.compactPython("later = 2", { retryWhenCapacityAvailable }),
            ),
        );
        expect(rejected.every((result) => result === undefined)).toBe(true);
        await occupied;
        expect(retries).toBe(1);
    } finally {
        await worker.dispose();
    }
});

it("retries after cancellation frees capacity without reentering worker teardown", async () => {
    const worker = tokenizer();
    const controller = new AbortController();
    let resumed: Promise<string[] | undefined> | undefined;
    try {
        const occupied = worker.compactPython("first = 1", { signal: controller.signal });
        await worker.compactPython("later = 2", {
            retryWhenCapacityAvailable: () => {
                resumed = worker.compactPython("resumed = 3");
            },
        });
        controller.abort();
        expect(await occupied).toBeUndefined();
        await Promise.resolve();
        expect(resumed).toBeDefined();
        expect(await resumed).toBeDefined();
    } finally {
        await worker.dispose();
    }
});

it("does not retry disposed work", async () => {
    const worker = tokenizer();
    let retries = 0;
    const occupied = worker.compactPython("first = 1");
    await worker.compactPython("later = 2", {
        retryWhenCapacityAvailable: () => {
            retries += 1;
        },
    });
    await worker.dispose();
    await occupied;
    await Promise.resolve();
    expect(retries).toBe(0);
});

it("does not let a broken invalidation prevent other owners from retrying", async () => {
    const worker = tokenizer();
    let retried = false;
    try {
        const occupied = worker.compactPython("first = 1");
        await worker.compactPython("bad = 2", {
            retryWhenCapacityAvailable: () => {
                throw new Error("invalid renderer");
            },
        });
        await worker.compactPython("good = 3", {
            retryWhenCapacityAvailable: () => {
                retried = true;
            },
        });
        await occupied;
        expect(retried).toBe(true);
    } finally {
        await worker.dispose();
    }
});

it("waits for capacity for async callers without a redraw callback", async () => {
    const worker = tokenizer();
    try {
        const first = worker.compactPython("first = 1");
        const second = worker.compactPython("second = 2");
        expect(await first).toEqual(["first = 1"]);
        expect(await second).toEqual(["second = 2"]);
    } finally {
        await worker.dispose();
    }
});

it("cancels capacity waits without losing later work", async () => {
    const worker = tokenizer();
    const controller = new AbortController();
    try {
        const first = worker.compactPython("first = 1");
        const cancelled = worker.compactPython("cancelled = 2", { signal: controller.signal });
        const later = worker.compactPython("later = 3");
        controller.abort();
        expect(await cancelled).toBeUndefined();
        expect(await first).toBeDefined();
        expect(await later).toEqual(["later = 3"]);
    } finally {
        await worker.dispose();
    }
});

it("settles async capacity waits on disposal", async () => {
    const worker = tokenizer();
    const first = worker.compactPython("first = 1");
    const second = worker.compactPython("second = 2");
    await worker.dispose();
    expect(await first).toBeUndefined();
    expect(await second).toBeUndefined();
});

it("admits oversized sources alone and then resumes smaller requests", async () => {
    const worker = tokenizer();
    const large = `# ${"padding ".repeat(200)}\nvalue = 1`;
    let resumed: Promise<string[] | undefined> | undefined;
    const retryWhenCapacityAvailable = () => {
        resumed = worker.compactPython("later = 2");
    };
    try {
        const pending = worker.compactPython(large);
        expect(
            await worker.compactPython("later = 2", { retryWhenCapacityAvailable }),
        ).toBeUndefined();
        expect(await pending).toEqual(large.split("\n"));
        expect(resumed).toBeDefined();
        expect(await resumed).toEqual(["later = 2"]);
    } finally {
        await worker.dispose();
    }
});

it("waits for existing work before admitting an oversized source", async () => {
    const worker = tokenizer();
    const large = `# ${"padding ".repeat(200)}\nvalue = 1`;
    try {
        const first = worker.compactPython("first = 1");
        const pending = worker.compactPython(large);
        expect(await first).toEqual(["first = 1"]);
        expect(await pending).toEqual(large.split("\n"));
    } finally {
        await worker.dispose();
    }
});
