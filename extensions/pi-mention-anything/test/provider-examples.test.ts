import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { createCommandProvider } from "../src/api.ts";

const request = {
    sourceId: "tickets",
    cwd: process.cwd(),
    trusted: true,
    query: "999",
    path: [],
    limit: 3,
    signal: new AbortController().signal,
};

test("published command example supports bounded query paging and exact resolution independently", async () => {
    const provider = createCommandProvider({
        command: process.execPath,
        args: [fileURLToPath(new URL("../examples/query-command.mjs", import.meta.url))],
        cwd: process.cwd(),
    });
    const first = await provider.discover(request);
    assert.deepEqual(
        first.items.map((candidate) => candidate.id),
        ["999", "9990", "9991"],
    );

    if (first.nextCursor === undefined) assert.fail("Expected a continuation cursor");

    const second = await provider.discover({ ...request, cursor: first.nextCursor });
    assert.deepEqual(
        second.items.map((candidate) => candidate.id),
        ["9992", "9993", "9994"],
    );
    const target = await provider.resolve({
        sourceId: "tickets",
        cwd: process.cwd(),
        trusted: true,
        segments: ["1000000"],
        signal: request.signal,
    });
    assert.equal(target.status, "resolved");
    assert.equal(target.path[0]?.replacement, "issue tracker ticket #1000000");
});
