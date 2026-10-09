import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";

import {
    COMMAND_PROVIDER_PROTOCOL_VERSION,
    createCommandProvider,
    executeJsonCommand,
} from "../src/command-provider.ts";
import type { Candidate } from "../src/source-contract.ts";

const cwd = process.cwd();

function nodeCommand(script: string, maxOutputBytes?: number) {
    return {
        command: process.execPath,
        args: ["-e", script],
        cwd,
        timeoutMs: 2_000,
        maxOutputBytes,
    };
}

test("undefined requests close stdin without writing data", async () => {
    const script = `let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ bytes: Buffer.byteLength(input) })));`;
    const result = await executeJsonCommand(
        nodeCommand(script),
        undefined,
        new AbortController().signal,
    );
    assert.deepEqual(result, { bytes: 0 });
});

test("protocol v1 sends explicit discovery and resolution requests", async () => {
    const script = `let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.version !== 1) process.exit(9);
  if (request.method === "discover") {
    process.stdout.write(JSON.stringify({
      version: 1,
      method: "discover",
      result: {
        items: [{
          id: request.query,
          label: request.path[0].label,
          segment: request.query,
          insertionText: "insert:" + request.query,
          selectable: true,
          navigable: false,
          data: { sourceId: request.sourceId, limit: request.limit, cursor: request.cursor }
        }],
        nextCursor: "next"
      }
    }));
    return;
  }
  process.stdout.write(JSON.stringify({
    version: 1,
    method: "resolve",
    result: {
      status: "resolved",
      path: [{ id: request.segments[0], label: request.cwd, segment: request.segments[0], insertionText: "resolved text", selectable: true, navigable: false }],
      replacement: request.trusted ? "trusted" : "untrusted"
    }
  }));
});`;
    const provider = createCommandProvider({ ...nodeCommand(script), filtering: "provider" });
    const parent: Candidate = {
        id: "parent-id",
        label: "Parent label",
        segment: "parent",
        selectable: false,
        navigable: true,
    };
    const discovery = await provider.discover({
        sourceId: "source",
        cwd,
        trusted: true,
        query: "needle",
        path: [parent],
        limit: 17,
        cursor: "page-2",
        signal: new AbortController().signal,
    });
    assert.equal(provider.filtering, "provider");
    assert.deepEqual(discovery, {
        items: [
            {
                id: "needle",
                label: "Parent label",
                segment: "needle",
                insertionText: "insert:needle",
                selectable: true,
                navigable: false,
                data: { sourceId: "source", limit: 17, cursor: "page-2" },
            },
        ],
        nextCursor: "next",
    });

    const resolution = await provider.resolve({
        sourceId: "source",
        cwd,
        trusted: true,
        segments: ["leaf"],
        signal: new AbortController().signal,
    });
    assert.deepEqual(resolution, {
        status: "resolved",
        path: [
            {
                id: "leaf",
                label: cwd,
                segment: "leaf",
                insertionText: "resolved text",
                selectable: true,
                navigable: false,
            },
        ],
        replacement: "trusted",
    });
    assert.equal(COMMAND_PROVIDER_PROTOCOL_VERSION, 1);
});

test("stdout and stderr share a strict output bound", async () => {
    await assert.rejects(
        executeJsonCommand(
            nodeCommand(`process.stdout.write("x".repeat(65));`, 64),
            undefined,
            new AbortController().signal,
        ),
        /maxOutputBytes/,
    );
    await assert.rejects(
        executeJsonCommand(
            nodeCommand(`process.stderr.write("x".repeat(65));`, 64),
            undefined,
            new AbortController().signal,
        ),
        /maxOutputBytes/,
    );
});

test("timeouts terminate commands and expose no stderr content", async () => {
    // This deliberately exercises the operating system process deadline; fake timers cannot drive a child process.
    const options = {
        ...nodeCommand(`setInterval(() => {}, 1_000);`),
        timeoutMs: 25,
    };
    await assert.rejects(
        executeJsonCommand(options, { secret: "not-for-errors" }, new AbortController().signal),
        /^Error: command timed out$/,
    );
});

test("child process start errors do not expose command paths or arguments", async () => {
    await assert.rejects(
        executeJsonCommand(
            {
                command: join(cwd, "secret-command-that-does-not-exist"),
                args: ["secret-argument"],
                cwd,
            },
            undefined,
            new AbortController().signal,
        ),
        /^Error: command could not be started$/,
    );
});

test("cancellation kills the spawned process tree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mention-command-"));
    const pidPath = join(directory, "grandchild.pid");
    const script = `const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(process.argv[1], String(child.pid));
setInterval(() => {}, 1000);`;
    const signal = new AbortController();
    const execution = executeJsonCommand(
        {
            command: process.execPath,
            args: ["-e", script, pidPath],
            cwd,
            timeoutMs: 2_000,
        },
        undefined,
        signal.signal,
    );
    let grandchildPid = 0;
    try {
        await vi.waitFor(async () => {
            grandchildPid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
            assert.ok(grandchildPid > 0);
        });
        signal.abort();
        await assert.rejects(execution, { name: "AbortError" });
        await vi.waitFor(() => {
            assert.throws(() => process.kill(grandchildPid, 0), { code: "ESRCH" });
        });
    } finally {
        if (grandchildPid > 0) {
            try {
                process.kill(grandchildPid, "SIGKILL");
            } catch {
                // The expected path already terminated the process.
            }
        }

        await rm(directory, { recursive: true, force: true });
    }
});

test("invalid protocol envelopes and nonzero exits reject safely", async () => {
    const invalid = createCommandProvider(
        nodeCommand(
            `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write('{"version":2}'));`,
        ),
    );
    await assert.rejects(
        invalid.discover({
            sourceId: "source",
            cwd,
            trusted: false,
            query: "",
            path: [],
            limit: 10,
            signal: new AbortController().signal,
        }),
        /invalid protocol v1 response/,
    );
    await assert.rejects(
        executeJsonCommand(
            nodeCommand(`process.stderr.write("secret"); process.exit(7);`),
            undefined,
            new AbortController().signal,
        ),
        /^Error: command failed$/,
    );
});

test("unsupported top-level JSON requests reject before spawning", async () => {
    await assert.rejects(
        executeJsonCommand(
            nodeCommand("process.exit(99)"),
            Symbol("private request"),
            new AbortController().signal,
        ),
        /^Error: command request must be JSON serializable$/,
    );
});
