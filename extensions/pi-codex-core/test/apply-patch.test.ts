import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
    ApplyPatchError,
    applyPatchText,
    formatApplyPatchError,
    parseApplyPatch,
} from "../src/apply-patch.ts";
import { createApplyPatchTool } from "../src/tools/apply-patch.ts";

function wrapPatch(body: string): string {
    return `*** Begin Patch\n${body}\n*** End Patch`;
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

    const parsed = parseApplyPatch(patch);

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

        const result = await applyPatchText(patch, root);

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

        await applyPatchText(patch, root);

        assert.equal(await readFile(join(root, "unicode.txt"), "utf8"), "import asyncio  # ok\n");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("apply_patch tool executes patch argument and formats parser errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-apply-patch-tool-"));
    try {
        const tool = createApplyPatchTool({ cwd: root });
        const params = tool.prepareArguments?.({
            patch: wrapPatch("*** Add File: hello.txt\n+hi"),
        });
        assert.ok(params);

        const ctx = { cwd: root };
        // SAFETY: This fixture supplies the ExtensionContext cwd read by apply_patch execution.
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

        let caught: unknown;
        try {
            parseApplyPatch("bad");
        } catch (cause: unknown) {
            caught = cause;
        }
        assert.ok(caught instanceof ApplyPatchError);
        assert.equal(
            formatApplyPatchError(caught),
            "Invalid patch: The first line of the patch must be '*** Begin Patch'",
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
