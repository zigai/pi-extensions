import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import type {
    TokenizeInitialization,
    TokenizeRequest,
} from "../../../src/rendering/syntax/tokenize-worker.ts";
import { createSyntaxTokenizer } from "../../../src/rendering/syntax/tokenizer.ts";

function deferred<T>() {
    let complete: (value: T) => void = () => {};
    const pending = new Promise<T>((resolve) => {
        complete = resolve;
    });

    return { pending, complete };
}

// A real Worker supplies the public Node boundary, but all protocol messages and
// termination acknowledgements are driven by the test, never by thread timing.
class ManualWorker extends Worker {
    readonly messages: Array<TokenizeInitialization | TokenizeRequest> = [];
    readonly termination = deferred<number>();
    terminationCalls = 0;

    constructor() {
        super('require("node:worker_threads").parentPort.on("message", () => {});', {
            eval: true,
            execArgv: [],
        });
    }

    override postMessage(message: TokenizeInitialization | TokenizeRequest): void {
        this.messages.push(message);
    }

    override async terminate(): Promise<number> {
        this.terminationCalls += 1;
        return this.termination.pending;
    }

    async closeThread(): Promise<void> {
        await super.terminate();
    }
}

async function flushTransitions(): Promise<void> {
    // Cleanup acknowledgement and the following startup barrier each have a
    // promise continuation; drain them without advancing any policy deadline.
    for (let step = 0; step < 8; step += 1) await Promise.resolve();
}

type TokenizerHarness = {
    readonly tokenizer: ReturnType<typeof createSyntaxTokenizer>;
    readonly workers: ManualWorker[];
    readonly warning: Mock<(message: string) => void>;
    readonly worker: (index?: number) => ManualWorker;
};

const harnesses: TokenizerHarness[] = [];

function harness(waitForDisposals: () => Promise<void> = async () => {}): TokenizerHarness {
    const workers: ManualWorker[] = [];
    const warning = vi.fn<(message: string) => void>();
    const tokenizer = createSyntaxTokenizer(undefined, {
        maxJobs: 3,
        maxBytes: 1024,
        reportWarning: warning,
        waitForDisposals,
        createWorker: () => {
            const current = new ManualWorker();
            workers.push(current);
            return current;
        },
    });
    const result = {
        tokenizer,
        workers,
        warning,
        worker(index = 0): ManualWorker {
            const current = workers[index];
            if (current === undefined) throw new Error(`Missing worker ${index}`);
            return current;
        },
    };
    harnesses.push(result);

    return result;
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(async () => {
    for (const current of harnesses.splice(0)) {
        const closing = current.tokenizer.dispose();
        const settled = Promise.allSettled([closing]);

        for (const worker of current.workers) worker.termination.complete(0);
        await vi.runAllTimersAsync();
        await settled;

        for (const worker of current.workers) await worker.closeThread();
    }

    vi.useRealTimers();
});

it("transfers an in-flight prior-disposal barrier to shutdown without creating a worker", async () => {
    const prior = deferred<void>();
    const current = harness(async () => prior.pending);
    const states: string[] = [];
    const pending = current.tokenizer.compactPython("queued", {
        onState: (state) => {
            states.push(state);
        },
    });
    await flushTransitions();
    expect(current.workers).toHaveLength(0);
    let closed = false;
    const closing = current.tokenizer.dispose().then(() => {
        closed = true;
    });
    expect(await pending).toBeUndefined();
    await flushTransitions();
    expect(closed).toBe(false);
    prior.complete();
    await closing;
    expect(states).toEqual(["queued"]);
    expect(current.workers).toHaveLength(0);
    expect(await current.tokenizer.compactPython("late")).toBeUndefined();
});

it("accepts readiness only during initialization and results only for the running request", async () => {
    const current = harness();
    const states: string[] = [];
    const first = current.tokenizer.compactPython("first", {
        onState: (state) => {
            states.push(`first:${state}`);
        },
    });
    const second = current.tokenizer.compactPython("second", {
        onState: (state) => {
            states.push(`second:${state}`);
        },
    });
    await flushTransitions();
    const worker = current.worker();
    expect(worker.messages).toHaveLength(1);
    worker.emit("message", { id: 0, lines: ["premature"] });
    expect(worker.messages).toHaveLength(1);
    worker.emit("message", { type: "ready" });
    worker.emit("message", { type: "ready" });
    worker.emit("message", { id: 1, lines: ["out of order"] });
    expect(worker.messages).toHaveLength(2);
    worker.emit("message", { id: 0, lines: ["first"] });
    expect(await first).toEqual(["first"]);
    worker.emit("message", { id: 0, lines: ["duplicate"] });
    worker.emit("message", { type: "ready" });
    expect(worker.messages).toHaveLength(3);
    worker.emit("message", { id: 1, lines: ["second"] });
    expect(await second).toEqual(["second"]);
    expect(states).toEqual(["first:queued", "second:queued", "first:running", "second:running"]);
});

it("finishes a cancelled running job on the same worker and drops its result", async () => {
    const current = harness();
    const abort = new AbortController();
    const reasons: string[] = [];
    const first = current.tokenizer.compactPython("first", {
        signal: abort.signal,
        onUnavailable: (reason) => {
            reasons.push(reason);
        },
    });
    const second = current.tokenizer.compactPython("second");
    await flushTransitions();
    const worker = current.worker();
    worker.emit("message", { type: "ready" });
    abort.abort();
    expect(await first).toBeUndefined();
    expect(worker.terminationCalls).toBe(0);
    expect(worker.messages).toHaveLength(2);
    worker.emit("message", { id: 1, lines: ["wrong request"] });
    worker.emit("message", { id: 0, lines: ["stale"] });
    expect(worker.messages).toHaveLength(3);
    worker.emit("message", { id: 1, lines: ["second"] });
    expect(await second).toEqual(["second"]);
    expect(current.workers).toHaveLength(1);
    expect(reasons).toEqual(["cancelled"]);
    expect(current.warning).not.toHaveBeenCalled();
});

it("stops a cancelled job that blocks queued work without warning", async () => {
    const current = harness();
    const abort = new AbortController();
    const first = current.tokenizer.compactPython("first", { signal: abort.signal });
    await flushTransitions();
    const old = current.worker();
    old.emit("message", { type: "ready" });
    abort.abort();
    expect(await first).toBeUndefined();
    const second = current.tokenizer.compactPython("second");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(old.terminationCalls).toBe(1);
    old.emit("message", { id: 0, lines: ["stale"] });
    old.termination.complete(0);
    await flushTransitions();
    const replacement = current.worker(1);
    replacement.emit("message", { type: "ready" });
    replacement.emit("message", { id: 1, lines: ["second"] });
    expect(await second).toEqual(["second"]);
    expect(current.warning).not.toHaveBeenCalled();
});

it("preserves the full job deadline without contention and waits for cleanup before restart", async () => {
    const current = harness();
    const reasons: string[] = [];
    const pending = current.tokenizer.compactPython("stalled", {
        onUnavailable: (reason) => {
            reasons.push(reason);
        },
    });
    await flushTransitions();
    const old = current.worker();
    old.emit("message", { type: "ready" });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(reasons).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeUndefined();
    expect(reasons).toEqual(["timeout"]);
    const next = current.tokenizer.compactPython("next");
    await flushTransitions();
    expect(current.workers).toHaveLength(1);
    old.termination.complete(0);
    await flushTransitions();
    const replacement = current.worker(1);
    replacement.emit("message", { type: "ready" });
    replacement.emit("message", { id: 1, lines: ["next"] });
    expect(await next).toEqual(["next"]);
});

it("keeps startup cooldown after cleanup and permits restart only on later demand", async () => {
    const current = harness();
    const reasons: string[] = [];
    const pending = current.tokenizer.compactPython("initial", {
        onUnavailable: (reason) => {
            reasons.push(reason);
        },
    });
    await flushTransitions();
    const old = current.worker();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toBeUndefined();
    old.termination.complete(0);
    await flushTransitions();
    old.emit("message", { type: "ready" });
    expect(
        await current.tokenizer.compactPython("early", {
            onUnavailable: (reason) => {
                reasons.push(reason);
            },
        }),
    ).toBeUndefined();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(current.workers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(current.workers).toHaveLength(1);
    const later = current.tokenizer.compactPython("later");
    await flushTransitions();
    const replacement = current.worker(1);
    replacement.emit("message", { type: "ready" });
    replacement.emit("message", { id: 2, lines: ["later"] });
    expect(await later).toEqual(["later"]);
    expect(reasons).toEqual(["startup-timeout", "startup-cooldown"]);
});

it("quarantines failed startup cleanup and releases its now-obsolete cooldown timer", async () => {
    const current = harness();
    const pending = current.tokenizer.compactPython("initial");
    await flushTransitions();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    const reasons: string[] = [];
    expect(
        await current.tokenizer.compactPython("later", {
            onUnavailable: (reason) => {
                reasons.push(reason);
            },
        }),
    ).toBeUndefined();

    expect(reasons).toEqual(["cleanup-timeout"]);
    expect(current.workers).toHaveLength(1);
    await expect(current.tokenizer.dispose()).rejects.toThrow("cleanup timeout");
    expect(vi.getTimerCount()).toBe(0);
});

it("settles running and queued work once when the owned worker fails", async () => {
    const current = harness();
    const reasons: string[] = [];
    const first = current.tokenizer.compactPython("first", {
        onUnavailable: (reason) => {
            reasons.push(reason);
        },
    });
    const second = current.tokenizer.compactPython("second", {
        onUnavailable: (reason) => {
            reasons.push(reason);
        },
    });
    await flushTransitions();
    const worker = current.worker();
    worker.emit("message", { type: "ready" });
    worker.emit("error", new Error("owned failure"));
    worker.emit("exit", 1);
    worker.emit("message", { id: 0, lines: ["too late"] });
    expect(await first).toBeUndefined();
    expect(await second).toBeUndefined();
    expect(reasons).toEqual(["failed", "failed"]);
    worker.termination.complete(0);
    await flushTransitions();
    expect(await current.tokenizer.compactPython("no restart")).toBeUndefined();
    expect(current.workers).toHaveLength(1);
    expect(current.warning).toHaveBeenCalledTimes(1);
});
