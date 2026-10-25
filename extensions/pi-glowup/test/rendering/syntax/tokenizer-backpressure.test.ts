import { expect, it } from "vitest";
import { createSyntaxTokenizer } from "../../../src/rendering/syntax/tokenizer.ts";

function tokenizer() {
    return createSyntaxTokenizer(undefined, {
        maxJobs: 1,
        maxBytes: 1024,
        reportWarning: undefined,
        waitForDisposals: async () => {},
    });
}

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
