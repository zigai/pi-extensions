import { execFile } from "node:child_process";
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
            else if (request.code.startsWith("slow")) {
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

it("resumes a tiny JavaScript request waiting behind an oversized source", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let running: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
        running = resolve;
    });
    const worker = createSyntaxTokenizer(
        { name: "test", settings: [] },
        {
            maxJobs: 100,
            maxBytes: 512 * 1024,
            reportWarning: undefined,
            waitForDisposals: async () => {},
            createWorker: () => controlledWorker(running),
        },
    );
    const slowReasons: string[] = [];
    const shortReasons: string[] = [];
    try {
        const slow = worker.tokenize(`slow${"x".repeat(512 * 1024)}`, "javascript", false, {
            onUnavailable: (reason) => {
                slowReasons.push(reason);
            },
        });
        await stalled;
        const short = worker.tokenize("const value = 1;", "javascript", false, {
            onUnavailable: (reason) => {
                shortReasons.push(reason);
            },
        });
        await vi.advanceTimersByTimeAsync(10_001);
        expect(slowReasons).toEqual(["timeout"]);
        expect(await slow).toBeUndefined();
        expect(await short).toEqual(["const value = 1;"]);
        expect(shortReasons).toEqual(["backpressure"]);
    } finally {
        await worker.dispose();
        vi.useRealTimers();
    }
});

it("resumes retry demand waiting behind an oversized source", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let running: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
        running = resolve;
    });
    const worker = createSyntaxTokenizer(
        { name: "test", settings: [] },
        {
            maxJobs: 100,
            maxBytes: 512 * 1024,
            reportWarning: undefined,
            waitForDisposals: async () => {},
            createWorker: () => controlledWorker(running),
        },
    );
    const slowReasons: string[] = [];
    const controller = new AbortController();
    let resumed: Promise<string[] | undefined> | undefined;
    try {
        const slow = worker.tokenize(`slow${"x".repeat(512 * 1024)}`, "javascript", false, {
            onUnavailable: (reason) => {
                slowReasons.push(reason);
            },
        });
        await stalled;
        expect(
            await worker.tokenize("const value = 1;", "javascript", false, {
                signal: controller.signal,
                retryWhenCapacityAvailable: () => {
                    resumed = worker.tokenize("const value = 1;", "javascript", false);
                },
            }),
        ).toBeUndefined();
        await vi.advanceTimersByTimeAsync(10_001);
        expect(slowReasons).toEqual(["timeout"]);
        expect(await slow).toBeUndefined();
        expect(resumed).toBeDefined();
        expect(await resumed).toEqual(["const value = 1;"]);
    } finally {
        controller.abort();
        await worker.dispose();
        vi.useRealTimers();
    }
});

it("keeps shared retry demand when one waiting request is cancelled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let running: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
        running = resolve;
    });
    const worker = createSyntaxTokenizer(
        { name: "test", settings: [] },
        {
            maxJobs: 100,
            maxBytes: 512 * 1024,
            reportWarning: undefined,
            waitForDisposals: async () => {},
            createWorker: () => controlledWorker(running),
        },
    );
    const slowReasons: string[] = [];
    const first = new AbortController();
    const second = new AbortController();
    let resumed: Promise<string[] | undefined> | undefined;
    const retry = () => {
        resumed = worker.tokenize("const second = 2;", "javascript", false);
    };

    const isNeeded = () => !first.signal.aborted || !second.signal.aborted;
    try {
        const slow = worker.tokenize(`slow${"x".repeat(512 * 1024)}`, "javascript", false, {
            onUnavailable: (reason) => {
                slowReasons.push(reason);
            },
        });
        await stalled;
        await worker.tokenize("const first = 1;", "javascript", false, {
            signal: first.signal,
            retryWhenCapacityAvailable: retry,
            isCapacityRetryNeeded: isNeeded,
        });
        await worker.tokenize("const second = 2;", "javascript", false, {
            signal: second.signal,
            retryWhenCapacityAvailable: retry,
            isCapacityRetryNeeded: isNeeded,
        });
        first.abort();
        await vi.advanceTimersByTimeAsync(10_001);
        expect(slowReasons).toEqual(["timeout"]);
        expect(await slow).toBeUndefined();
        expect(resumed).toBeDefined();
        expect(await resumed).toEqual(["const second = 2;"]);
    } finally {
        second.abort();
        await worker.dispose();
        vi.useRealTimers();
    }
});

it("does not interrupt an oversized source after waiting demand is cancelled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let running: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
        running = resolve;
    });
    const worker = createSyntaxTokenizer(
        { name: "test", settings: [] },
        {
            maxJobs: 100,
            maxBytes: 512 * 1024,
            reportWarning: undefined,
            waitForDisposals: async () => {},
            createWorker: () => controlledWorker(running),
        },
    );
    const reasons: string[] = [];
    const controller = new AbortController();
    try {
        const slow = worker.tokenize(`slow${"x".repeat(512 * 1024)}`, "javascript", false, {
            onUnavailable: (reason) => {
                reasons.push(reason);
            },
        });
        await stalled;
        const short = worker.tokenize("const value = 1;", "javascript", false, {
            signal: controller.signal,
        });
        controller.abort();
        expect(await short).toBeUndefined();
        await vi.advanceTimersByTimeAsync(10_001);
        expect(reasons).toEqual([]);
        await worker.dispose();
        expect(await slow).toBeUndefined();
        expect(reasons).toEqual(["cancelled"]);
    } finally {
        await worker.dispose();
        vi.useRealTimers();
    }
});

it("does not interrupt an oversized source after a retry demand is cancelled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let running: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
        running = resolve;
    });
    const worker = createSyntaxTokenizer(
        { name: "test", settings: [] },
        {
            maxJobs: 100,
            maxBytes: 512 * 1024,
            reportWarning: undefined,
            waitForDisposals: async () => {},
            createWorker: () => controlledWorker(running),
        },
    );
    const reasons: string[] = [];
    const controller = new AbortController();
    const isNeeded = () => !controller.signal.aborted;
    let retries = 0;
    try {
        const slow = worker.tokenize(`slow${"x".repeat(512 * 1024)}`, "javascript", false, {
            onUnavailable: (reason) => {
                reasons.push(reason);
            },
        });
        await stalled;
        expect(
            await worker.tokenize("const value = 1;", "javascript", false, {
                signal: controller.signal,
                retryWhenCapacityAvailable: () => {
                    retries += 1;
                },
                isCapacityRetryNeeded: isNeeded,
            }),
        ).toBeUndefined();

        controller.abort();
        await vi.advanceTimersByTimeAsync(10_001);
        expect(reasons).toEqual([]);
        expect(retries).toBe(0);
        await worker.dispose();
        expect(await slow).toBeUndefined();
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

it("fails queued work and shutdown when worker termination does not settle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let markStalled: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
        markStalled = resolve;
    });
    let release: () => void = () => {};
    let stopped: Promise<number> | undefined;
    let workers = 0;
    const worker = createSyntaxTokenizer(undefined, {
        maxJobs: 2,
        maxBytes: 1024,
        reportWarning: undefined,
        waitForDisposals: async () => {},
        createWorker: () => {
            workers += 1;
            const current = controlledWorker(markStalled);
            const terminate = current.terminate.bind(current);
            current.terminate = async () => {
                const pending = new Promise<number>((resolve, reject) => {
                    release = () => {
                        stopped = terminate();
                        void stopped.then(resolve, reject);
                    };
                });

                return pending;
            };

            return current;
        },
    });
    const reasons: string[] = [];
    try {
        const slow = worker.compactPython("slow");
        await stalled;
        const short = worker.compactPython("short", {
            onUnavailable: (reason) => {
                reasons.push(reason);
            },
        });
        vi.advanceTimersToNextTimer();
        expect(await slow).toBeUndefined();
        await vi.advanceTimersToNextTimerAsync();
        expect(reasons).toEqual(["cleanup-timeout"]);
        expect(await short).toBeUndefined();
        await expect(worker.dispose()).rejects.toThrow(/cleanup/i);
        expect(workers).toBe(1);
    } finally {
        release();

        if (stopped !== undefined) await stopped;
        await Promise.allSettled([worker.dispose()]);
        vi.useRealTimers();
    }
});

it("lets the process exit after reporting unconfirmed worker cleanup", async () => {
    const tokenizerUrl = new URL("../../../src/rendering/syntax/tokenizer.ts", import.meta.url)
        .href;
    const source = `
        import { Worker } from "node:worker_threads";
        import { createSyntaxTokenizer } from ${JSON.stringify(tokenizerUrl)};
        let markRunning;
        const running = new Promise((resolve) => { markRunning = resolve; });
        const tokenizer = createSyntaxTokenizer(undefined, {
            maxJobs: 2, maxBytes: 1024, reportWarning: undefined,
            waitForDisposals: async () => {},
            createWorker: () => {
                const worker = new Worker(\`const { parentPort } = require("node:worker_threads");
                    parentPort.on("message", (request) => {
                        if (request.type === "initialize") parentPort.postMessage({ type: "ready" });
                        else { parentPort.postMessage({ id: -1, lines: [] }); while (true) {} }
                    });\`, { eval: true, execArgv: [] });
                worker.on("message", (message) => { if (message.id === -1) markRunning(); });
                worker.terminate = () => new Promise(() => {});
                return worker;
            },
        });
        const work = tokenizer.compactPython("slow");
        await running;
        const timers = new Map();
        const clear = globalThis.clearTimeout;
        let next = 0;
        globalThis.setTimeout = (callback) => { const id = ++next; timers.set(id, callback); return id; };
        globalThis.clearTimeout = (id) => {
            if (typeof id === "number") timers.delete(id);
            else clear(id);
        };
        const closing = tokenizer.dispose();
        for (const callback of timers.values()) callback();
        await work;
        try { await closing; process.exitCode = 1; }
        catch (error) {
            if (!(error instanceof Error) || !error.message.includes("cleanup")) throw error;
            console.log("cleanup unconfirmed");
        }
    `;
    const output = await new Promise<string>((resolve, reject) => {
        execFile(
            process.execPath,
            ["--input-type=module", "--eval", source],
            { timeout: 10_000 },
            (error, stdout) => {
                if (error === null) resolve(stdout);
                else reject(new Error("Worker probe failed", { cause: error }));
            },
        );
    });
    expect(output.trim()).toBe("cleanup unconfirmed");
});

it("fails without starting a worker when prior disposal never settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let release: () => void = () => {};
    const previous = new Promise<void>((resolve) => {
        release = resolve;
    });
    let workers = 0;
    const reasons: string[] = [];
    const worker = createSyntaxTokenizer(undefined, {
        maxJobs: 2,
        maxBytes: 1024,
        reportWarning: undefined,
        waitForDisposals: async () => previous,
        createWorker: () => {
            workers += 1;

            return controlledWorker(() => {});
        },
    });
    try {
        const pending = worker.compactPython("short", {
            onUnavailable: (reason) => {
                reasons.push(reason);
            },
        });
        await Promise.resolve();
        vi.advanceTimersToNextTimer();
        await Promise.resolve();
        await Promise.resolve();
        expect(reasons).toEqual(["cleanup-timeout"]);
        expect(await pending).toBeUndefined();
        await expect(worker.dispose()).rejects.toThrow(/cleanup/i);
        expect(workers).toBe(0);
    } finally {
        release();
        await Promise.allSettled([worker.dispose()]);
        vi.useRealTimers();
    }
});

it("quarantines a worker when termination rejects", async () => {
    let markStalled: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
        markStalled = resolve;
    });
    let stopped: Promise<number> | undefined;
    let workers = 0;
    const worker = createSyntaxTokenizer(undefined, {
        maxJobs: 2,
        maxBytes: 1024,
        reportWarning: undefined,
        waitForDisposals: async () => {},
        createWorker: () => {
            workers += 1;
            const current = controlledWorker(markStalled);
            const terminate = current.terminate.bind(current);
            current.terminate = async () => {
                stopped = terminate();
                return Promise.reject(new Error("termination failed"));
            };

            return current;
        },
    });
    const controller = new AbortController();
    const reasons: string[] = [];
    try {
        const slow = worker.compactPython("slow", { signal: controller.signal });
        await stalled;
        const short = worker.compactPython("short", {
            onUnavailable: (reason) => {
                reasons.push(reason);
            },
        });
        controller.abort();
        expect(await slow).toBeUndefined();
        expect(await short).toBeUndefined();
        expect(reasons).toEqual(["cleanup-failed"]);
        await expect(worker.dispose()).rejects.toThrow(/cleanup/i);
        expect(workers).toBe(1);
    } finally {
        if (stopped !== undefined) await stopped;
        await Promise.allSettled([worker.dispose()]);
    }
});

it("fails when a previous disposal rejects", async () => {
    const reasons: string[] = [];
    let workers = 0;
    const worker = createSyntaxTokenizer(undefined, {
        maxJobs: 2,
        maxBytes: 1024,
        reportWarning: undefined,
        waitForDisposals: async () => {
            throw new Error("previous cleanup failed");
        },
        createWorker: () => {
            workers += 1;

            return controlledWorker(() => {});
        },
    });
    try {
        expect(
            await worker.compactPython("short", {
                onUnavailable: (reason) => {
                    reasons.push(reason);
                },
            }),
        ).toBeUndefined();

        expect(reasons).toEqual(["cleanup-failed"]);
        expect(workers).toBe(0);
        await expect(worker.dispose()).rejects.toThrow(/cleanup/i);
    } finally {
        await Promise.allSettled([worker.dispose()]);
    }
});

it("reports startup timeout and allows a later request to recover", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let markOnline: () => void = () => {};
    const online = new Promise<void>((resolve) => {
        markOnline = resolve;
    });
    let markExit: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
        markExit = resolve;
    });
    let workers = 0;
    const reasons: string[] = [];
    const worker = createSyntaxTokenizer(undefined, {
        maxJobs: 2,
        maxBytes: 1024,
        reportWarning: undefined,
        waitForDisposals: async () => {},
        createWorker: () => {
            workers += 1;
            if (workers > 1) return controlledWorker(() => {});

            const current = new Worker(
                'require("node:worker_threads").parentPort.on("message", () => {});',
                { eval: true },
            );
            current.once("online", markOnline);
            current.once("exit", markExit);

            return current;
        },
    });
    try {
        const pending = worker.compactPython("first", {
            onUnavailable: (reason) => {
                reasons.push(reason);
            },
        });
        await online;
        vi.advanceTimersToNextTimer();
        expect(await pending).toBeUndefined();
        expect(reasons).toEqual(["startup-timeout"]);
        expect(
            await worker.compactPython("early", {
                onUnavailable: (reason) => {
                    reasons.push(reason);
                },
            }),
        ).toBeUndefined();

        expect(reasons).toEqual(["startup-timeout", "startup-cooldown"]);
        expect(workers).toBe(1);
        await exited;
        await new Promise<void>((resolve) => {
            setImmediate(resolve);
        });
        vi.advanceTimersToNextTimer();
        expect(workers).toBe(1);
        expect(await worker.compactPython("later")).toEqual(["later"]);
        expect(workers).toBe(2);
    } finally {
        await Promise.allSettled([worker.dispose()]);
        vi.useRealTimers();
    }
});

it("wakes current capacity demand after startup cooldown", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let markOnline: () => void = () => {};
    const online = new Promise<void>((resolve) => {
        markOnline = resolve;
    });
    let markExit: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
        markExit = resolve;
    });
    let workers = 0;
    let callbacks = 0;
    let cancelledCallbacks = 0;
    let resumed: Promise<string[] | undefined> | undefined;
    const controller = new AbortController();
    const retry = () => {
        callbacks += 1;
        resumed = worker.compactPython("waiting");
    };

    const obsoleteRetry = () => {
        cancelledCallbacks += 1;
    };

    const worker = createSyntaxTokenizer(undefined, {
        maxJobs: 1,
        maxBytes: 1024,
        reportWarning: undefined,
        waitForDisposals: async () => {},
        createWorker: () => {
            workers += 1;
            if (workers > 1) return controlledWorker(() => {});

            const current = new Worker(
                'require("node:worker_threads").parentPort.on("message", () => {});',
                { eval: true },
            );
            current.once("online", markOnline);
            current.once("exit", markExit);

            return current;
        },
    });
    try {
        const first = worker.compactPython("first");
        await online;
        await worker.compactPython("waiting", { retryWhenCapacityAvailable: retry });
        await worker.compactPython("obsolete", {
            signal: controller.signal,
            retryWhenCapacityAvailable: obsoleteRetry,
        });
        vi.advanceTimersToNextTimer();
        expect(await first).toBeUndefined();
        controller.abort();
        await exited;
        await new Promise<void>((resolve) => {
            setImmediate(resolve);
        });
        expect(callbacks).toBe(0);
        expect(workers).toBe(1);
        await vi.advanceTimersToNextTimerAsync();
        expect(callbacks).toBe(1);
        expect(cancelledCallbacks).toBe(0);
        expect(resumed).toBeDefined();
        expect(await resumed).toEqual(["waiting"]);
        expect(workers).toBe(2);
    } finally {
        await worker.dispose();
        vi.useRealTimers();
    }
});

it("permits a capacity owner to register again after startup recovery", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let markOnline: () => void = () => {};
    const online = new Promise<void>((resolve) => {
        markOnline = resolve;
    });
    let markExit: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
        markExit = resolve;
    });
    let markStalled: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
        markStalled = resolve;
    });
    let workers = 0;
    let retries = 0;
    const retry = () => {
        retries += 1;
    };

    const worker = createSyntaxTokenizer(undefined, {
        maxJobs: 1,
        maxBytes: 1024,
        reportWarning: undefined,
        waitForDisposals: async () => {},
        createWorker: () => {
            workers += 1;
            if (workers > 1) return controlledWorker(markStalled);

            const current = new Worker(
                'require("node:worker_threads").parentPort.on("message", () => {});',
                { eval: true },
            );
            current.once("online", markOnline);
            current.once("exit", markExit);

            return current;
        },
    });
    const controller = new AbortController();
    try {
        const first = worker.compactPython("first");
        await online;
        expect(
            await worker.compactPython("waiting", { retryWhenCapacityAvailable: retry }),
        ).toBeUndefined();

        vi.advanceTimersToNextTimer();
        expect(await first).toBeUndefined();
        expect(retries).toBe(0);
        await exited;
        await new Promise<void>((resolve) => {
            setImmediate(resolve);
        });
        await vi.advanceTimersToNextTimerAsync();
        expect(retries).toBe(1);
        const slow = worker.compactPython("slow", { signal: controller.signal });
        await stalled;
        expect(
            await worker.compactPython("later", { retryWhenCapacityAvailable: retry }),
        ).toBeUndefined();

        controller.abort();
        expect(await slow).toBeUndefined();
        await Promise.resolve();
        expect(retries).toBe(2);
    } finally {
        await worker.dispose();
        vi.useRealTimers();
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
            Array.from({ length: 20 }, async () =>
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
