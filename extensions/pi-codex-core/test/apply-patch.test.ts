import assert from "node:assert/strict";
import {
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readlink,
    realpath,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { withFileMutationQueue, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Result as BetterResult } from "better-result";

import {
    ApplyPatchError,
    ApplyPatchExecutionError,
    applyPatchText,
    formatApplyPatchError,
    parseApplyPatch,
    type ApplyPatchFileSystem,
} from "../src/tools/apply-patch/engine.ts";
import { createApplyPatchTool } from "../src/tools/apply-patch/tool.ts";
import { makeExtensionContext } from "./helpers.ts";

function wrapPatch(body: string): string {
    return `*** Begin Patch\n${body}\n*** End Patch`;
}

function expectApplyPatchSuccess<T>(result: BetterResult<T, ApplyPatchError>): T {
    if (result.isErr()) assert.fail(formatApplyPatchError(result.error));
    return result.value;
}

function expectApplyPatchFailure<T>(result: BetterResult<T, ApplyPatchError>): ApplyPatchError {
    if (result.isOk()) assert.fail("Expected apply_patch to fail.");
    return result.error;
}

function createNodeFileSystem(): ApplyPatchFileSystem {
    return {
        readFile: (path) => readFile(path, "utf8"),
        writeFile: (path, contents) => writeFile(path, contents, "utf8"),
        lstat: (path) => lstat(path),
        mkdir: async (path) => {
            await mkdir(path, { recursive: true });
        },
        readlink: (path) => readlink(path),
        realpath: (path) => realpath(path),
        removeFile: async (path) => {
            await rm(path, { force: false, recursive: false });
        },
    };
}

test("parses Codex apply_patch add, delete, update, and move hunks", () => {
    const patch = wrapPatch(`*** Add File: add.txt
+hello
*** Delete File: gone.txt
*** Update File: old.txt
*** Move to: new.txt
@@
-old
+new`);

    const parsed = expectApplyPatchSuccess(parseApplyPatch(patch));

    assert.deepEqual(parsed.hunks, [
        { type: "add", path: "add.txt", contents: "hello\n" },
        { type: "delete", path: "gone.txt" },
        {
            type: "update",
            path: "old.txt",
            movePath: "new.txt",
            chunks: [
                {
                    changeContext: undefined,
                    oldLines: ["old"],
                    newLines: ["new"],
                    isEndOfFile: false,
                },
            ],
        },
    ]);
});

test("applies Codex apply_patch changes to the local filesystem", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-apply-patch-"));
    try {
        await writeFile(join(root, "delete.txt"), "remove me\n");
        await writeFile(join(root, "update.txt"), "foo\nbar\n");
        await mkdir(join(root, "old"), { recursive: true });
        await writeFile(join(root, "old", "name.txt"), "old name\n");

        const patch = wrapPatch(`*** Add File: nested/add.txt
+created
*** Delete File: delete.txt
*** Update File: update.txt
@@
 foo
-bar
+baz
*** Update File: old/name.txt
*** Move to: renamed/name.txt
@@
-old name
+new name`);

        const result = expectApplyPatchSuccess(await applyPatchText(patch, root));

        assert.equal(await readFile(join(root, "nested", "add.txt"), "utf8"), "created\n");
        await assert.rejects(readFile(join(root, "delete.txt"), "utf8"));
        assert.equal(await readFile(join(root, "update.txt"), "utf8"), "foo\nbaz\n");
        await assert.rejects(readFile(join(root, "old", "name.txt"), "utf8"));
        assert.equal(await readFile(join(root, "renamed", "name.txt"), "utf8"), "new name\n");
        assert.equal(
            result.summary,
            "Success. Updated the following files:\nA nested/add.txt\nM update.txt\nM renamed/name.txt\nD delete.txt\n",
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("apply_patch update matching follows Codex whitespace and Unicode lenience", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-apply-patch-fuzzy-"));
    try {
        await writeFile(
            join(root, "unicode.txt"),
            "    import asyncio  # local import \u2013 avoids top\u2011level dep   \n",
        );
        const patch = wrapPatch(`*** Update File: unicode.txt
@@
-import asyncio  # local import - avoids top-level dep
+import asyncio  # ok`);

        expectApplyPatchSuccess(await applyPatchText(patch, root));

        assert.equal(await readFile(join(root, "unicode.txt"), "utf8"), "import asyncio  # ok\n");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("preflights every hunk before mutating any file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-apply-patch-preflight-"));
    try {
        const patch = wrapPatch(`*** Add File: would-have-been-created.txt
+created
*** Update File: missing.txt
@@
-missing
+updated`);

        assert.ok(
            expectApplyPatchFailure(await applyPatchText(patch, root)) instanceof ApplyPatchError,
        );
        await assert.rejects(readFile(join(root, "would-have-been-created.txt"), "utf8"));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("applies an add followed by a dependent update to the same path", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-apply-patch-add-update-"));
    try {
        const patch = wrapPatch(`*** Add File: sequential.txt
+initial
*** Update File: sequential.txt
@@
-initial
+final`);

        const result = expectApplyPatchSuccess(await applyPatchText(patch, root));

        assert.equal(await readFile(join(root, "sequential.txt"), "utf8"), "final\n");
        assert.deepEqual(result.affectedPaths, {
            added: ["sequential.txt"],
            modified: ["sequential.txt"],
            deleted: [],
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("applies sequential dependent updates to the same path", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-apply-patch-update-update-"));
    try {
        const filePath = join(root, "sequential.txt");
        await writeFile(filePath, "original\n");
        const patch = wrapPatch(`*** Update File: sequential.txt
@@
-original
+intermediate
*** Update File: sequential.txt
@@
-intermediate
+final`);

        expectApplyPatchSuccess(await applyPatchText(patch, root));

        assert.equal(await readFile(filePath, "utf8"), "final\n");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("applies an operation to the destination of an earlier move", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-apply-patch-move-update-"));
    try {
        await writeFile(join(root, "source.txt"), "original\n");
        const patch = wrapPatch(`*** Update File: source.txt
*** Move to: destination.txt
@@
-original
+intermediate
*** Update File: destination.txt
@@
-intermediate
+final`);

        expectApplyPatchSuccess(await applyPatchText(patch, root));

        await assert.rejects(readFile(join(root, "source.txt"), "utf8"));
        assert.equal(await readFile(join(root, "destination.txt"), "utf8"), "final\n");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("rejects parsed environment IDs before mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-apply-patch-environment-"));
    try {
        const patch = `*** Begin Patch
*** Environment ID: remote-environment
*** Add File: rejected.txt
+not written
*** End Patch`;

        const failure = expectApplyPatchFailure(await applyPatchText(patch, root));
        assert.equal(failure.kind, "invalidPatch");
        assert.match(failure.message, /no environment selector/);
        await assert.rejects(readFile(join(root, "rejected.txt"), "utf8"));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("denies traversal and external absolute paths while allowing absolute paths in cwd", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-codex-core-apply-patch-boundary-"));
    const root = join(base, "root");
    const outside = join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    try {
        const traversalFailure = expectApplyPatchFailure(
            await applyPatchText(
                wrapPatch("*** Add File: ../outside/traversal.txt\n+denied"),
                root,
            ),
        );
        assert.equal(traversalFailure.kind, "unauthorizedPath");
        const absoluteFailure = expectApplyPatchFailure(
            await applyPatchText(
                wrapPatch(`*** Add File: ${join(outside, "absolute.txt")}\n+denied`),
                root,
            ),
        );
        assert.equal(absoluteFailure.kind, "unauthorizedPath");
        await assert.rejects(readFile(join(outside, "traversal.txt"), "utf8"));
        await assert.rejects(readFile(join(outside, "absolute.txt"), "utf8"));

        const absoluteInsidePath = join(root, "absolute-inside.txt");
        expectApplyPatchSuccess(
            await applyPatchText(wrapPatch(`*** Add File: ${absoluteInsidePath}\n+allowed`), root),
        );
        assert.equal(await readFile(absoluteInsidePath, "utf8"), "allowed\n");
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

test("denies paths that escape cwd through an existing symlink", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-codex-core-apply-patch-symlink-"));
    const root = join(base, "root");
    const outside = join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, "escape"), "dir");
    try {
        const failure = expectApplyPatchFailure(
            await applyPatchText(wrapPatch("*** Add File: escape/through-link.txt\n+denied"), root),
        );
        assert.equal(failure.kind, "unauthorizedPath");
        await assert.rejects(readFile(join(outside, "through-link.txt"), "utf8"));
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

test("rejects sequential hunks that alias the same file before mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-apply-patch-alias-"));
    try {
        const filePath = join(root, "real.txt");
        await writeFile(filePath, "original\n");
        await symlink(filePath, join(root, "alias.txt"));
        const patch = wrapPatch(`*** Update File: real.txt
@@
-original
+first
*** Update File: alias.txt
@@
-original
+second`);

        const failure = expectApplyPatchFailure(await applyPatchText(patch, root));
        assert.equal(failure.kind, "compute");
        assert.match(failure.message, /same filesystem target/);
        assert.equal(await readFile(filePath, "utf8"), "original\n");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("checks cancellation before the first filesystem mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-apply-patch-cancelled-"));
    const controller = new AbortController();
    controller.abort();
    try {
        const failure = expectApplyPatchFailure(
            await applyPatchText(wrapPatch("*** Add File: cancelled.txt\n+not written"), root, {
                signal: controller.signal,
            }),
        );
        assert.equal(failure.kind, "cancelled");
        await assert.rejects(readFile(join(root, "cancelled.txt"), "utf8"));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("rejects a stale preflight snapshot before overwriting an external mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-apply-patch-conflict-"));
    const filePath = join(root, "stale.txt");
    await writeFile(filePath, "original\n");
    try {
        const baseFileSystem = createNodeFileSystem();
        let injectedMutation = false;
        const fileSystem: ApplyPatchFileSystem = {
            ...baseFileSystem,
            readFile: async (path) => {
                const contents = await baseFileSystem.readFile(path);
                if (path === filePath && !injectedMutation) {
                    injectedMutation = true;
                    await baseFileSystem.writeFile(path, "external\n");
                }
                return contents;
            },
        };
        const patch = wrapPatch(`*** Update File: stale.txt
@@
-original
+patched`);

        const failure = expectApplyPatchFailure(await applyPatchText(patch, root, { fileSystem }));
        assert.equal(failure.kind, "conflict");
        assert.match(failure.message, /concurrent change/);
        assert.equal(await readFile(filePath, "utf8"), "external\n");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("reports a failed write as uncertain even when no mutation was confirmed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-apply-patch-partial-"));
    const filePath = join(root, "uncertain.txt");
    await writeFile(filePath, "original\n");
    try {
        const baseFileSystem = createNodeFileSystem();
        const fileSystem: ApplyPatchFileSystem = {
            ...baseFileSystem,
            writeFile: async (path, contents) => {
                await baseFileSystem.writeFile(path, contents);
                throw new Error("simulated failure after a potentially partial write");
            },
        };
        const patch = wrapPatch(`*** Update File: uncertain.txt
@@
-original
+replacement`);

        const failure = expectApplyPatchFailure(await applyPatchText(patch, root, { fileSystem }));
        assert.ok(failure instanceof ApplyPatchExecutionError);
        assert.deepEqual(failure.committedResult.changes, []);
        assert.deepEqual(failure.uncertainPaths, [filePath]);
        assert.match(
            formatApplyPatchError(failure),
            /state is uncertain:[\s\S]*\? .*uncertain\.txt/,
        );
        assert.equal(await readFile(filePath, "utf8"), "replacement\n");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("apply_patch tool executes patch argument and formats parser errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-apply-patch-tool-"));
    try {
        const tool = createApplyPatchTool();
        const params = tool.prepareArguments?.({
            patch: wrapPatch("*** Add File: hello.txt\n+hi"),
        });
        assert.ok(params);

        const ctx = { cwd: root };
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: This fixture supplies the ExtensionContext cwd read by apply_patch execution.
        const executionContext = ctx as unknown as ExtensionContext;
        const result = await tool.execute("call-1", params, undefined, undefined, executionContext);

        assert.equal(await readFile(join(root, "hello.txt"), "utf8"), "hi\n");
        assert.equal(result.content[0]?.type, "text");
        assert.match(result.content[0]?.text ?? "", /A hello\.txt/);
        assert.match(result.details.diff, /hello\.txt\n\+1 hi/);
        assert.match(result.details.patch, /--- hello\.txt\n\+\+\+ hello\.txt/);
        assert.deepEqual(result.details.lineSummary, {
            files: [
                {
                    action: "A",
                    path: "hello.txt",
                    addedLines: 1,
                    removedLines: 0,
                },
            ],
            addedLines: 1,
            removedLines: 0,
            unknownRemovedFileCount: 0,
        });

        const failure = expectApplyPatchFailure(parseApplyPatch("bad"));
        assert.equal(
            formatApplyPatchError(failure),
            "Invalid patch: The first line of the patch must be '*** Begin Patch'",
        );
        await assert.rejects(
            tool.execute("call-invalid", { patch: "bad" }, undefined, undefined, executionContext),
            (cause: unknown) =>
                cause instanceof Error &&
                cause.message ===
                    "Invalid patch: The first line of the patch must be '*** Begin Patch'",
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("apply_patch argument preparation accepts compatibility shapes and rejects ambiguity", () => {
    const prepareArguments = createApplyPatchTool().prepareArguments;
    assert.ok(prepareArguments);
    const patch = wrapPatch("*** Add File: compatible.txt\n+compatible");

    assert.deepEqual(prepareArguments(patch), { patch });
    assert.deepEqual(prepareArguments({ patch }), { patch });
    assert.deepEqual(prepareArguments({ input: patch }), { patch });
    assert.deepEqual(prepareArguments({ command: patch }), { patch });

    assert.throws(() => prepareArguments({ patch, extra: true }), /Invalid apply_patch arguments/);
    assert.throws(() => prepareArguments({ patch, input: patch }), /Invalid apply_patch arguments/);
    assert.throws(
        () => prepareArguments({ command: patch, obsolete: patch }),
        /Invalid apply_patch arguments/,
    );
});

test("apply_patch shares target-file locks with Pi write operations", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-apply-patch-lock-"));
    try {
        const filePath = join(root, "shared.txt");
        await writeFile(filePath, "before\n");
        let releaseBlocker: (() => void) | undefined;
        let markBlockerStarted: (() => void) | undefined;
        const blockerStarted = new Promise<void>((resolveStarted) => {
            markBlockerStarted = resolveStarted;
        });
        const blockerGate = new Promise<void>((resolveBlocker) => {
            releaseBlocker = resolveBlocker;
        });
        const competingWrite = withFileMutationQueue(filePath, async () => {
            markBlockerStarted?.();
            await blockerGate;
            await writeFile(filePath, "before\nexternal\n");
        });
        await blockerStarted;

        const tool = createApplyPatchTool();
        const patch = wrapPatch(`*** Update File: shared.txt
@@
-before
+after`);
        const ctx = makeExtensionContext(root, true);
        const patchResult = tool.execute("call-lock", { patch }, undefined, undefined, ctx);
        releaseBlocker?.();

        await Promise.all([competingWrite, patchResult]);
        assert.equal(await readFile(filePath, "utf8"), "after\nexternal\n");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
