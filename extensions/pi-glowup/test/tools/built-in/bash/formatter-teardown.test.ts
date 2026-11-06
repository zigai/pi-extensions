import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    runFormatterCommand,
    type FormatterProcess,
    type FormatterProcessOptions,
    type FormatterRun,
} from "../../../../src/tools/built-in/bash/formatter-process.ts";

class FormatterChild extends EventEmitter implements FormatterProcess {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly kill = vi.fn<(_signal?: NodeJS.Signals) => boolean>(() => true);
    readonly release = vi.fn<() => void>();
    readonly warning = vi.fn<(message: string) => void>();
    closed = false;

    close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
        if (this.closed) return;

        this.closed = true;
        this.emit("close", code, signal);
    }
}

const children: FormatterChild[] = [];
const results: Promise<FormatterRun>[] = [];

function format(code = "source", options: FormatterProcessOptions = {}) {
    const child = new FormatterChild();
    children.push(child);
    const result = runFormatterCommand(
        "mock-formatter",
        [],
        code,
        options,
        child.release,
        undefined,
        child.warning,
        () => child,
    );
    results.push(result);

    return { child, result };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(async () => {
    for (const child of children.splice(0)) child.close();
    await Promise.all(results.splice(0));
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
});

describe("formatter result versus child ownership", () => {
    it("publishes successful output and releases its resource only on close", async () => {
        const { child, result } = format();
        child.stdout.emit("data", "const source = 1;\n");
        expect(child.release).not.toHaveBeenCalled();
        child.close();
        expect(await result).toMatchObject({ output: "const source = 1;\n", outcome: "formatted" });
        expect(child.release).toHaveBeenCalledTimes(1);
        expect(child.kill).not.toHaveBeenCalled();
    });

    it("does not mistake process exit for stdio closure", async () => {
        const { child, result } = format();
        let published = false;
        void result.then(() => {
            published = true;
        });

        child.stdout.emit("data", "formatted\n");
        child.emit("exit", 0, null);
        await Promise.resolve();
        expect(published).toBe(false);
        expect(child.release).not.toHaveBeenCalled();
        child.close();
        expect(await result).toMatchObject({ output: "formatted\n", outcome: "formatted" });
        expect(child.release).toHaveBeenCalledTimes(1);
    });

    it("settles cancellation but retains ownership until the terminated child closes", async () => {
        const controller = new AbortController();
        const { child, result } = format("source", { signal: controller.signal });
        controller.abort();
        expect(await result).toMatchObject({ output: undefined, outcome: "cancelled" });
        expect(child.release).not.toHaveBeenCalled();
        expect(child.kill).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(250);
        expect(child.kill).toHaveBeenCalledWith("SIGKILL");
        expect(child.release).not.toHaveBeenCalled();
        child.close(null, "SIGKILL");
        expect(child.release).toHaveBeenCalledTimes(1);
    });

    it("ignores late output and repeated errors after the result has settled", async () => {
        const { child, result } = format();
        child.stdin.emit("error", new Error("input failed"));
        expect(await result).toMatchObject({ output: undefined, outcome: "failed" });
        child.stdout.emit("data", "late formatted output");
        child.stdin.emit("error", new Error("input failed again"));
        child.emit("error", new Error("late child error"));
        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(child.release).not.toHaveBeenCalled();
        child.close();
        child.emit("error", new Error("after close"));
        child.emit("close", 0, null);
        expect(await result).toMatchObject({ output: undefined, outcome: "failed" });
        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(child.release).toHaveBeenCalledTimes(1);
    });

    it("does not rearm escalation when TERM synchronously closes the child", async () => {
        const { child, result } = format();
        child.kill.mockImplementation(() => {
            child.close(null, "SIGTERM");
            return true;
        });

        child.stdin.emit("error", new Error("input failed"));
        expect(await result).toMatchObject({ output: undefined, outcome: "failed" });
        await vi.advanceTimersByTimeAsync(250);
        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(child.release).toHaveBeenCalledTimes(1);
    });

    it("keeps timeout settled even when a later close reports success", async () => {
        const { child, result } = format();
        await vi.advanceTimersByTimeAsync(5_100);
        expect(await result).toMatchObject({ output: undefined, outcome: "timeout" });
        expect(child.release).not.toHaveBeenCalled();
        child.stdout.emit("data", "too late");
        child.close();
        expect(await result).toMatchObject({ output: undefined, outcome: "timeout" });
        expect(child.release).toHaveBeenCalledTimes(1);
    });

    it("settles output overflow while preserving child ownership until close", async () => {
        const { child, result } = format();
        child.stdout.emit("data", "x".repeat(1024 * 1024 + 1));
        expect(await result).toMatchObject({ output: undefined, outcome: "output-limit" });
        expect(child.release).not.toHaveBeenCalled();
        child.close();
        expect(child.release).toHaveBeenCalledTimes(1);
    });

    it("releases immediately when spawning fails, without arming child timers", async () => {
        const release = vi.fn<() => void>();
        const warning = vi.fn<(message: string) => void>();
        const result = await runFormatterCommand(
            "unavailable",
            [],
            "source",
            {},
            release,
            undefined,
            warning,
            () => {
                throw new Error("spawn failed");
            },
        );
        expect(result).toEqual({ output: undefined, outcome: "failed" });
        expect(release).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledWith("could not start");
    });
});
