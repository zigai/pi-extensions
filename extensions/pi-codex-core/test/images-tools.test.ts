import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import assert from "node:assert/strict";
import { test } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { DEFAULT_CODEX_CORE_CONFIG } from "../src/config/config.ts";
import {
    MAX_INPUT_IMAGE_BYTES,
    codexPromptImageTargetDimensions,
    loadImageContent,
    saveGeneratedImage,
} from "../src/images/content.ts";
import { createImagegenTool } from "../src/tools/imagegen.ts";
import { createApplyPatchTool } from "../src/tools/apply-patch/tool.ts";
import { createViewImageTool } from "../src/tools/view-image/tool.ts";
import { formatWebRunToolOutput } from "../src/tools/web-run/output.ts";
import { createWebRunTool } from "../src/tools/web-run/tool.ts";
import { imageDetailMarker, rewriteProviderImageDetails } from "../src/images/detail.ts";
import {
    TEST_THEME,
    makeTestRuntime,
    renderComponent,
    makeRenderContext,
    messageEntry,
    isRecord,
} from "./helpers.ts";

test("renders compact invocation summaries for Codex tools", () => {
    const webRunTool = createWebRunTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
    assert.ok(webRunTool.renderCall);
    const webRunArgs = {
        search_query: [{ q: "official TypeScript documentation handbook" }],
        response_length: "short" as const,
    };
    assert.match(
        renderComponent(
            webRunTool.renderCall(webRunArgs, TEST_THEME, makeRenderContext(webRunArgs)),
        ),
        /web_run search "official TypeScript documentation handbook" • length=short/,
    );

    const imagegenTool = createImagegenTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
    assert.ok(imagegenTool.renderCall);
    const imagegenArgs = {
        prompt: "Make a compact blue robot icon with enough descriptive words to prove the prompt is not truncated early",
        referenced_image_paths: ["input.png"],
    };
    const renderedImagegenCall = renderComponent(
        imagegenTool.renderCall(imagegenArgs, TEST_THEME, makeRenderContext(imagegenArgs)),
    );
    assert.match(renderedImagegenCall, /imagegen "Make a compact blue robot icon/);
    assert.match(renderedImagegenCall, /not truncated early"/);
    assert.doesNotMatch(renderedImagegenCall, /…/);
    assert.match(renderedImagegenCall, /refs=1/);

    const viewImageTool = createViewImageTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
    assert.ok(viewImageTool.renderCall);
    const viewImageArgs = {
        path: "/tmp/pi-agent/pi-codex-core/imagegen/session/latest.png",
        detail: "high" as const,
    };
    assert.match(
        renderComponent(
            viewImageTool.renderCall(viewImageArgs, TEST_THEME, makeRenderContext(viewImageArgs)),
        ),
        /view_image \/tmp\/pi-agent\/pi-codex-core\/imagegen\/session\/latest\.png • detail=high/,
    );

    const applyPatchTool = createApplyPatchTool();
    assert.ok(applyPatchTool.renderCall);
    const applyPatchArgs = {
        patch: `*** Begin Patch
*** Update File: Scripts/pi-memory-bench.py
@@
-old
+new
*** End Patch`,
    };
    const renderedApplyPatchCall = renderComponent(
        applyPatchTool.renderCall(applyPatchArgs, TEST_THEME, makeRenderContext(applyPatchArgs)),
    );
    assert.match(
        renderedApplyPatchCall.split("\n")[0] ?? "",
        /apply_patch M Scripts\/pi-memory-bench\.py • \+1 -1/,
    );
    assert.match(renderedApplyPatchCall, /Scripts\/pi-memory-bench\.py/);
    assert.match(renderedApplyPatchCall, /- old/);
    assert.match(renderedApplyPatchCall, /\+ new/);
});

test("renders apply_patch results with line stats and expanded diffs", () => {
    const applyPatchTool = createApplyPatchTool();
    assert.ok(applyPatchTool.renderResult);
    const args = {
        patch: `*** Begin Patch
*** Update File: Scripts/pi-memory-bench.py
@@
-old
+new
*** End Patch`,
    };
    const result = {
        content: [
            {
                type: "text" as const,
                text: "Success. Updated the following files:\nM Scripts/pi-memory-bench.py\n",
            },
        ],
        details: {
            affectedPaths: { added: [], modified: ["Scripts/pi-memory-bench.py"], deleted: [] },
            changedFileCount: 1,
            lineSummary: {
                files: [
                    {
                        action: "M" as const,
                        path: "Scripts/pi-memory-bench.py",
                        addedLines: 1,
                        removedLines: 1,
                    },
                ],
                addedLines: 1,
                removedLines: 1,
                unknownRemovedFileCount: 0,
            },
            diff: "Scripts/pi-memory-bench.py\n-1 old\n+1 new",
            patch: "--- Scripts/pi-memory-bench.py\n+++ Scripts/pi-memory-bench.py\n@@ -1 +1 @@\n-old\n+new\n",
            firstChangedLine: 1,
        },
    };

    const compact = renderComponent(
        applyPatchTool.renderResult(
            result,
            { expanded: false, isPartial: false },
            TEST_THEME,
            makeRenderContext(args),
        ),
    );
    assert.match(compact, /M Scripts\/pi-memory-bench\.py \+1 -1/);
    assert.match(compact, /Scripts\/pi-memory-bench\.py/);
    assert.match(compact, /-1 old/);
    assert.match(compact, /\+1 new/);

    const expanded = renderComponent(
        applyPatchTool.renderResult(
            result,
            { expanded: true, isPartial: false },
            TEST_THEME,
            makeRenderContext(args, undefined, { expanded: true }),
        ),
    );
    assert.match(expanded, /Success\. Updated the following files:/);
    assert.match(expanded, /Scripts\/pi-memory-bench\.py/);
    assert.match(expanded, /-1 old/);
    assert.match(expanded, /\+1 new/);
});

test("rejects invalid tool arguments before I/O", () => {
    const webRunTool = createWebRunTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
    assert.ok(webRunTool.prepareArguments);
    assert.throws(
        () => webRunTool.prepareArguments?.({ search_query: [{ q: 42 }] }),
        /Invalid web_run arguments/,
    );
    assert.throws(() => webRunTool.prepareArguments?.({}), /web_run requires at least one/);
    assert.throws(
        () => webRunTool.prepareArguments?.({ response_length: "short" }),
        /at least one non-empty command/,
    );
    assert.throws(
        () =>
            webRunTool.prepareArguments?.({
                search_query: [],
                settings: { search_context_size: "low" },
            }),
        /at least one non-empty command/,
    );

    const imagegenTool = createImagegenTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
    assert.ok(imagegenTool.prepareArguments);
    assert.throws(() => imagegenTool.prepareArguments?.({}), /Invalid imagegen arguments/);
    assert.throws(
        () => imagegenTool.prepareArguments?.({ prompt: "draw", referenced_image_paths: [123] }),
        /Invalid imagegen arguments/,
    );
    assert.throws(
        () => imagegenTool.prepareArguments?.({ prompt: "draw", images: ["input.png"] }),
        /Invalid imagegen arguments/,
    );
    assert.throws(
        () => imagegenTool.prepareArguments?.({ prompt: "draw", num_last_images_to_include: 1.5 }),
        /Invalid imagegen arguments/,
    );

    const viewImageTool = createViewImageTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
    assert.ok(viewImageTool.prepareArguments);
    assert.throws(() => viewImageTool.prepareArguments?.({ file_path: 123 }), /Invalid view_image/);
    assert.throws(() => viewImageTool.prepareArguments?.({}), /view_image requires a path/);
});

test("computes Codex prompt image target dimensions", () => {
    assert.deepEqual(codexPromptImageTargetDimensions(2304, 864), {
        width: 2048,
        height: 768,
    });
    assert.deepEqual(codexPromptImageTargetDimensions(1024, 4096), {
        width: 512,
        height: 2048,
    });
    assert.deepEqual(codexPromptImageTargetDimensions(2048, 2048), {
        width: 1600,
        height: 1600,
    });
});

test("reads image dimensions without full-buffer base64 conversion", async () => {
    const source = await readFile("src/images/metadata.ts", "utf8");

    assert.match(source, /export function imageDimensionsFromBytes/);
    assert.doesNotMatch(source, /getImageDimensions|toString\("base64"\)/);
});

test("rejects oversized and mislabeled image files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-image-load-"));
    try {
        await writeFile(join(root, "fake.png"), "not actually an image");
        await assert.rejects(
            loadImageContent("fake.png", root),
            /Unsupported or invalid image file/,
        );

        await writeFile(
            join(root, "corrupt.png"),
            Buffer.concat([
                Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
                Buffer.alloc(64),
            ]),
        );
        await assert.rejects(
            loadImageContent("corrupt.png", root),
            /Unsupported or invalid image file/,
        );

        const oversized = Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Buffer.alloc(MAX_INPUT_IMAGE_BYTES),
        ]);
        await writeFile(join(root, "oversized.png"), oversized);
        await assert.rejects(loadImageContent("oversized.png", root), /Image is too large/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("rejects image paths outside the workspace and through symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-image-boundary-"));
    const cwd = join(root, "workspace");
    const outside = join(root, "outside.png");
    try {
        await mkdir(cwd, { recursive: true });
        await writeFile(outside, solidPngBytes(1, 1, [1, 2, 3, 255]));
        await symlink(outside, join(cwd, "escape.png"));

        await assert.rejects(loadImageContent(outside, cwd), /outside the workspace/);
        await assert.rejects(loadImageContent("escape.png", cwd), /outside the workspace/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("view_image returns durable image content with Codex patch budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-view-image-"));
    try {
        const imagePath = join(root, "square.png");
        await writeFile(imagePath, solidPngBytes(2048, 2048, [40, 80, 120, 255]));
        const viewImageTool = createViewImageTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
        const result = await viewImageTool.execute(
            "view-image-resize",
            { path: "square.png" },
            undefined,
            undefined,
            makeImageContext(root),
        );

        const image = result.content.find(
            (
                item,
            ): item is {
                readonly type: "image";
                readonly data: string;
                readonly mimeType: string;
            } =>
                isRecord(item) &&
                item.type === "image" &&
                typeof item.data === "string" &&
                typeof item.mimeType === "string",
        );
        assert.ok(image);
        const dimensions = getImageDimensions(image.data, image.mimeType);
        assert.deepEqual(dimensions, { widthPx: 1600, heightPx: 1600 });
        assert.equal(result.details.detail, "high");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("view_image preserves supported original detail", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-view-original-"));
    try {
        await writeFile(join(root, "wide.png"), solidPngBytes(3000, 100, [1, 2, 3, 255]));
        const tool = createViewImageTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
        const result = await tool.execute(
            "view-original",
            { path: "wide.png", detail: "original" },
            undefined,
            undefined,
            makeImageContext(root),
        );
        const image = result.content.find(
            (
                item,
            ): item is {
                readonly type: "image";
                readonly data: string;
                readonly mimeType: string;
            } =>
                isRecord(item) &&
                item.type === "image" &&
                typeof item.data === "string" &&
                typeof item.mimeType === "string",
        );
        assert.ok(image);
        assert.deepEqual(getImageDimensions(image.data, image.mimeType), {
            widthPx: 3000,
            heightPx: 100,
        });
        assert.equal(result.details.detail, "original");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("restores durable image detail markers in provider requests", () => {
    const rewritten = rewriteProviderImageDetails({
        input: [
            {
                type: "function_call_output",
                call_id: "call_1",
                output: [
                    {
                        type: "input_text",
                        text: `${imageDetailMarker("original")}\nSaved at /tmp/image.png`,
                    },
                    { type: "input_image", detail: "auto", image_url: "data:image/png;base64,x" },
                ],
            },
        ],
    });

    assert.ok(isRecord(rewritten));
    assert.ok(Array.isArray(rewritten.input));
    const [output] = rewritten.input;
    assert.ok(isRecord(output));
    assert.deepEqual(output.output, [
        { type: "input_text", text: "Saved at /tmp/image.png" },
        { type: "input_image", detail: "original", image_url: "data:image/png;base64,x" },
    ]);
});

test("renders compact web_run results until expanded", () => {
    const webRunTool = createWebRunTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
    assert.ok(webRunTool.renderResult);
    const rawOutputPath = "/tmp/pi-agent/pi-codex-core/web-run/session/call.txt";
    const output = [
        "Extensions · Docs · Pi (https://pi.dev/docs/latest/extensions)",
        "L10: Tools can provide renderCall and renderResult for custom TUI display.",
        "--------------------",
        "Pi Coding Agent (https://pi.dev/)",
        "L20: Build a custom workflow extension.",
        "--------------------",
        "GitHub Docs (https://github.com/earendil-works/pi)",
        "L30: Browse the source repository.",
    ].join("\n");
    const result = {
        content: [{ type: "text" as const, text: output }],
        details: {
            fullOutputPath: rawOutputPath,
            outputCharacters: output.length,
            sourceCount: 3,
        },
    };

    const compact = renderComponent(
        webRunTool.renderResult(
            result,
            { expanded: false, isPartial: false },
            TEST_THEME,
            makeRenderContext({}),
        ),
    );
    assert.match(compact, /3 sources/);
    assert.match(compact, /Extensions · Docs · Pi/);
    assert.match(compact, /https:\/\/pi\.dev\/docs\/latest\/extensions/);
    assert.match(compact, /… 1 more/);
    assert.doesNotMatch(compact, /Key lines/);

    const expanded = renderComponent(
        webRunTool.renderResult(
            result,
            { expanded: true, isPartial: false },
            TEST_THEME,
            makeRenderContext({}, undefined, { expanded: true }),
        ),
    );
    assert.match(expanded, /Key lines/);
});

test("renders viewed image fallback when inline images are hidden", () => {
    const viewImageTool = createViewImageTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
    assert.ok(viewImageTool.renderResult);
    const args = { path: "image.png" };
    const result = {
        content: [
            {
                type: "image" as const,
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
                mimeType: "image/png",
            },
        ],
        details: {
            path: "image.png",
            absolutePath: "/tmp/image.png",
            described: false,
            mimeType: "image/png",
        },
    };

    const rendered = renderComponent(
        viewImageTool.renderResult(
            result,
            { expanded: false, isPartial: false },
            TEST_THEME,
            makeRenderContext(args, { preview: null }, { showImages: false }),
        ),
    );

    assert.doesNotMatch(rendered, /Viewing image\.png/);
    assert.match(rendered, /\[Image: image\.png \[image\/png\] 1x1\]/);
});

test("renders non-inline view_image results without loading a preview file", () => {
    const viewImageTool = createViewImageTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
    assert.ok(viewImageTool.renderResult);
    const args = { path: "image.png" };
    const result = {
        content: [],
        details: {
            path: "image.png",
            absolutePath: "/tmp/image.png",
            described: true,
            mimeType: "image/png",
        },
    };
    const state = {};

    const rendered = renderComponent(
        viewImageTool.renderResult(
            result,
            { expanded: false, isPartial: false },
            TEST_THEME,
            makeRenderContext(args, state),
        ),
    );

    assert.equal(rendered.trimEnd(), "Image saved at image.png");
    assert.deepEqual(state, {});
});

test("renders viewed inline images when terminal images are available", () => {
    const viewImageTool = createViewImageTool({
        getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
        capabilities: {
            getCapabilities: () => ({ images: "kitty", trueColor: true, hyperlinks: true }),
        },
        imageComponentFactory: () => ({
            invalidate() {},
            render: () => ["\u001B_Gfake-inline-image"],
        }),
    });
    assert.ok(viewImageTool.renderResult);
    const args = { path: "image.png" };
    const result = {
        content: [
            {
                type: "image" as const,
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
                mimeType: "image/png",
            },
        ],
        details: {
            path: "image.png",
            absolutePath: "/tmp/image.png",
            described: false,
            mimeType: "image/png",
        },
    };

    const rendered = renderComponent(
        viewImageTool.renderResult(
            result,
            { expanded: false, isPartial: false },
            TEST_THEME,
            makeRenderContext(args, { preview: null }),
        ),
    );

    assert.ok(rendered.includes("\u001B_G"));
});

test("formats web_run output without Codex citation markers", () => {
    const rawOutput = [
        "Claude and Codex now available - GitHub Changelog (https://github.blog/example)",
        'citeturn1view1 [wordlim: 200] Content type: text/html; Source: open({"ref_id":"turn0search2"}); Total lines: 232',
        "L0: cite0† Skip to content ",
        "L39: Claude by Anthropic and OpenAI Codex are now available as coding agents for Copilot Business and Copilot Pro customers.",
        "L41: You can run Claude, Codex, and Copilot directly inside github.com, GitHub Mobile, and VS Code.",
    ].join("\n");

    const rawOutputPath = "/tmp/pi-agent/pi-codex-core/web-run/session/call.txt";
    const formatted = formatWebRunToolOutput(rawOutput, rawOutputPath);

    assert.equal(formatted.sourceCount, 1);
    assert.doesNotMatch(formatted.text, /cite/);
    assert.match(
        formatted.text,
        /Full raw Codex search output: \/tmp\/pi-agent\/pi-codex-core\/web-run\/session\/call\.txt/,
    );
    assert.match(formatted.text, /URL: https:\/\/github\.blog\/example/);
    assert.match(formatted.text, /L39: Claude by Anthropic/);
    assert.doesNotMatch(formatted.text, /Skip to content/);
});

test("saves web_run raw output outside workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    let requestBody: unknown;
    const runtime = makeTestRuntime(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as unknown;
        return new Response(JSON.stringify({ output: "1. Pi\n   URL: https://pi.dev/" }), {
            status: 200,
        });
    });

    try {
        await mkdir(cwd, { recursive: true });
        const webRunTool = createWebRunTool({
            getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
            runtime,
            agentDir,
        });
        const result = await webRunTool.execute(
            "call/1",
            { search_query: [{ q: "Pi docs" }], response_length: "short" },
            undefined,
            undefined,
            makeWebRunContext(cwd),
        );
        const rawOutputPath = join(agentDir, "pi-codex-core", "web-run", "session_1", "call_1.txt");

        assert.ok(isRecord(requestBody));
        assert.deepEqual(requestBody.commands, {
            search_query: [{ q: "Pi docs" }],
            response_length: "short",
        });
        assert.equal(requestBody.response_length, undefined);
        assert.equal(requestBody.id, "session/1");
        assert.equal(requestBody.max_output_tokens, 10_000);
        assert.deepEqual(requestBody.settings, {
            allowed_callers: ["direct"],
            external_web_access: true,
        });
        assert.equal(result.details.fullOutputPath, rawOutputPath);
        assert.deepEqual(result.content, [
            { type: "text", text: "1. Pi\n   URL: https://pi.dev/" },
        ]);
        assert.equal(
            (await readFile(rawOutputPath)).toString("utf8"),
            "1. Pi\n   URL: https://pi.dev/",
        );
        await assert.rejects(readFile(join(cwd, ".pi", "codex-core-web-run", "call_1.txt")), {
            code: "ENOENT",
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("web_run sends Codex-compatible recent visible history", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-web-history-"));
    let requestBody: unknown;
    const runtime = makeTestRuntime(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as unknown;
        return new Response(JSON.stringify({ output: "done" }), { status: 200 });
    });
    const ctx = makeWebRunContextWithBranch(root, [
        messageEntry("system", null, { role: "system", content: "do not include" }),
        messageEntry("old-user", "system", { role: "user", content: "old user" }),
        messageEntry("old-assistant", "old-user", {
            role: "assistant",
            content: [{ type: "text", text: "old assistant" }],
        }),
        messageEntry("previous-user", "old-assistant", {
            role: "user",
            content: [{ type: "text", text: "previous user" }],
        }),
        messageEntry("previous-assistant", "previous-user", {
            role: "assistant",
            content: [{ type: "text", text: "previous assistant" }],
        }),
        messageEntry("developer", "previous-assistant", {
            role: "developer",
            content: "do not include",
        }),
        messageEntry("current-user", "developer", { role: "user", content: "current user" }),
        messageEntry("current-commentary", "current-user", {
            role: "assistant",
            content: [{ type: "text", text: "do not include after latest user" }],
        }),
    ]);

    try {
        const webRunTool = createWebRunTool({
            getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
            runtime,
            agentDir: join(root, "agent"),
        });
        await webRunTool.execute(
            "call/1",
            { search_query: [{ q: "Pi docs" }] },
            undefined,
            undefined,
            ctx,
        );

        assert.ok(isRecord(requestBody));
        assert.deepEqual(requestBody.input, [
            {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "previous user" }],
            },
            {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "previous assistant" }],
            },
            {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "current user" }],
            },
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("web_run rejects invalid unsigned command fields", () => {
    const webRunTool = createWebRunTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
    assert.ok(webRunTool.prepareArguments);
    assert.throws(
        () => webRunTool.prepareArguments?.({ screenshot: [{ ref_id: "turn0view0", pageno: -1 }] }),
        /Invalid web_run arguments/,
    );
    assert.throws(
        () => webRunTool.prepareArguments?.({ click: [{ ref_id: "turn0view0", id: 1.5 }] }),
        /Invalid web_run arguments/,
    );
});

test("imagegen returns model-visible images and saved paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-imagegen-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        const cwd = join(root, "workspace");
        const agentDir = join(root, "agent");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        await mkdir(cwd, { recursive: true });
        const png = solidPngBytes(1, 1, [20, 40, 60, 255]);
        const base64 = png.toString("base64");
        const runtime = makeTestRuntime(
            async () =>
                new Response(JSON.stringify({ data: [{ b64_json: base64 }], size: "1024x1024" }), {
                    status: 200,
                }),
        );
        const imagegenTool = createImagegenTool({
            getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
            runtime,
        });

        const result = await imagegenTool.execute(
            "call/1",
            { prompt: "Draw a blue robot" },
            undefined,
            undefined,
            makeWebRunContext(cwd),
        );
        const imagePath = join(agentDir, "pi-codex-core", "imagegen", "session_1", "call_1.png");
        const latestPath = join(agentDir, "pi-codex-core", "imagegen", "session_1", "latest.png");

        assert.equal(result.content.length, 3);
        assert.deepEqual(result.content[0], {
            type: "image",
            data: base64,
            mimeType: "image/png",
        });
        assert.deepEqual(result.content[2], {
            type: "text",
            text: [
                "Generated image output:",
                `- image: ${imagePath}`,
                `- latest image: ${latestPath}`,
                "- size=1024x1024",
            ].join("\n"),
        });
        assert.deepEqual(await readFile(imagePath), png);
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
    }
});

test("imagegen uses an available Codex provider under a non-Responses model", async () => {
    const base64 = solidPngBytes(1, 1, [20, 40, 60, 255]).toString("base64");
    let requestUrl = "";
    const runtime = makeTestRuntime(async (input) => {
        requestUrl = String(input);
        return new Response(JSON.stringify({ data: [{ b64_json: base64 }] }), { status: 200 });
    });
    const codexModel = {
        provider: "openai-codex",
        api: "openai-codex-responses",
        id: "gpt-5.5",
        baseUrl: "https://chatgpt.com/backend-api",
    };
    const ctx = {
        cwd: "/workspace",
        model: {
            provider: "anthropic",
            api: "anthropic-messages",
            id: "claude-sonnet",
        },
        modelRegistry: {
            find: (provider: string, modelId: string) =>
                provider === "openai-codex" && modelId === "gpt-5.5" ? codexModel : undefined,
            getApiKeyAndHeaders: async () => ({
                ok: true,
                apiKey: "token",
                headers: { "chatgpt-account-id": "account" },
            }),
        },
        sessionManager: {
            getSessionId: () => "session/1",
            getBranch: () => [],
        },
    } as unknown as ExtensionContext;
    const imagegenTool = createImagegenTool({
        getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
        runtime,
        async saveImage(args) {
            return {
                path: `/tmp/${args.index}.png`,
                absolutePath: `/tmp/${args.index}.png`,
                latestPath: "/tmp/latest.png",
                latestAbsolutePath: "/tmp/latest.png",
            };
        },
    });

    const result = await imagegenTool.execute(
        "call/1",
        { prompt: "Draw a blue robot" },
        undefined,
        undefined,
        ctx,
    );

    assert.equal(result.details.generatedCount, 1);
    assert.equal(requestUrl, "https://chatgpt.com/backend-api/codex/images/generations");
});

test("imagegen saves generated images sequentially", async () => {
    const base64A = solidPngBytes(1, 1, [255, 0, 0, 255]).toString("base64");
    const base64B = solidPngBytes(1, 1, [0, 255, 0, 255]).toString("base64");
    const runtime = makeTestRuntime(
        async () =>
            new Response(JSON.stringify({ data: [{ b64_json: base64A }, { b64_json: base64B }] }), {
                status: 200,
            }),
    );
    let activeSaves = 0;
    let maxActiveSaves = 0;
    const savedOrder: string[] = [];
    const imagegenTool = createImagegenTool({
        getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
        runtime,
        async saveImage(args) {
            activeSaves += 1;
            maxActiveSaves = Math.max(maxActiveSaves, activeSaves);
            await Promise.resolve();
            savedOrder.push(args.base64);
            activeSaves -= 1;
            return {
                path: `/tmp/${args.index}.png`,
                absolutePath: `/tmp/${args.index}.png`,
                latestPath: "/tmp/latest.png",
                latestAbsolutePath: "/tmp/latest.png",
            };
        },
    });

    await imagegenTool.execute(
        "call/1",
        { prompt: "Draw two robots" },
        undefined,
        undefined,
        makeWebRunContext("/workspace"),
    );

    assert.equal(maxActiveSaves, 1);
    assert.deepEqual(savedOrder, [base64A, base64B]);
});

test("imagegen keeps generated output when artifact persistence fails", async () => {
    const base64 = solidPngBytes(1, 1, [1, 2, 3, 255]).toString("base64");
    const tool = createImagegenTool({
        getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
        runtime: makeTestRuntime(
            async () =>
                new Response(JSON.stringify({ data: [{ b64_json: base64 }] }), { status: 200 }),
        ),
        async saveImage() {
            throw new Error("disk unavailable");
        },
    });

    const result = await tool.execute(
        "call/1",
        { prompt: "Draw a robot" },
        undefined,
        undefined,
        makeWebRunContext("/workspace"),
    );

    assert.equal(result.content[0]?.type, "image");
    assert.deepEqual(result.details.images, []);
    assert.deepEqual(result.details.saveErrors, ["disk unavailable"]);
    assert.match(JSON.stringify(result.content), /save warning: disk unavailable/);
});

test("imagegen retries transient failures and rejects malformed image payloads", async () => {
    const base64 = solidPngBytes(1, 1, [1, 2, 3, 255]).toString("base64");
    let attempts = 0;
    const retryingTool = createImagegenTool({
        getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
        runtime: makeTestRuntime(async () => {
            attempts += 1;
            return attempts === 1
                ? new Response("temporary", { status: 500 })
                : new Response(JSON.stringify({ data: [{ b64_json: base64 }] }), { status: 200 });
        }),
        async saveImage(args) {
            return {
                path: `/tmp/${args.index}.png`,
                absolutePath: `/tmp/${args.index}.png`,
                latestPath: "/tmp/latest.png",
                latestAbsolutePath: "/tmp/latest.png",
            };
        },
    });
    await retryingTool.execute(
        "call/1",
        { prompt: "Draw a robot" },
        undefined,
        undefined,
        makeWebRunContext("/workspace"),
    );
    assert.equal(attempts, 2);

    const malformedTool = createImagegenTool({
        getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
        runtime: makeTestRuntime(
            async () =>
                new Response(JSON.stringify({ data: [{ b64_json: "AAAA" }] }), { status: 200 }),
        ),
    });
    await assert.rejects(
        malformedTool.execute(
            "call/2",
            { prompt: "Draw a robot" },
            undefined,
            undefined,
            makeWebRunContext("/workspace"),
        ),
        /not a valid PNG/,
    );
});

test("imagegen edits recent generated image artifacts from tool details", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-imagegen-recent-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        const cwd = join(root, "workspace");
        const agentDir = join(root, "agent");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const previousImagePath = join(cwd, "previous.png");
        await mkdir(cwd, { recursive: true });
        await writeFile(previousImagePath, solidPngBytes(1, 1, [0, 0, 255, 255]));
        const editedBase64 = solidPngBytes(1, 1, [255, 0, 0, 255]).toString("base64");
        let requestUrl = "";
        let requestBody: unknown;
        const runtime = makeTestRuntime(async (input, init) => {
            requestUrl = String(input);
            requestBody = JSON.parse(String(init?.body)) as unknown;
            return new Response(JSON.stringify({ data: [{ b64_json: editedBase64 }] }), {
                status: 200,
            });
        });
        const imagegenTool = createImagegenTool({
            getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
            runtime,
        });
        const ctx = makeWebRunContextWithBranch(cwd, [
            messageEntry("imagegen-result", null, {
                role: "toolResult",
                content: [
                    {
                        type: "text",
                        text: `Generated image output:\n- image: ${previousImagePath}`,
                    },
                ],
                details: {
                    images: [
                        {
                            path: previousImagePath,
                            absolutePath: previousImagePath,
                            latestPath: previousImagePath,
                            latestAbsolutePath: previousImagePath,
                        },
                    ],
                },
            }),
        ]);

        await imagegenTool.execute(
            "call/2",
            { prompt: "Make the recent image red", num_last_images_to_include: 1 },
            undefined,
            undefined,
            ctx,
        );

        assert.match(requestUrl, /\/images\/edits$/);
        assert.ok(isRecord(requestBody));
        assert.ok(Array.isArray(requestBody.images));
        const [editImage] = requestBody.images;
        assert.ok(isRecord(editImage));
        assert.equal(
            editImage.image_url,
            `data:image/png;base64,${solidPngBytes(1, 1, [0, 0, 255, 255]).toString("base64")}`,
        );
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
    }
});

test("saves generated images outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");

    try {
        await mkdir(cwd, { recursive: true });
        await writeFile(join(cwd, "latest.png"), "do not replace");
        const png = solidPngBytes(1, 1, [10, 20, 30, 255]);
        const base64 = png.toString("base64");
        const saved = await saveGeneratedImage({
            sessionId: "session/1",
            toolCallId: "call*1",
            index: 0,
            base64,
            agentDir,
        });
        const imagePath = join(agentDir, "pi-codex-core", "imagegen", "session_1", "call_1.png");
        const latestPath = join(agentDir, "pi-codex-core", "imagegen", "session_1", "latest.png");

        assert.equal(saved.path, imagePath);
        assert.equal(saved.latestPath, latestPath);
        assert.deepEqual(await readFile(saved.absolutePath), png);
        assert.deepEqual(await readFile(saved.latestAbsolutePath), png);
        assert.equal((await readFile(join(cwd, "latest.png"))).toString("utf8"), "do not replace");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("allocates unique generated image artifact names on retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-imagegen-retry-"));
    const agentDir = join(root, "agent");

    try {
        const firstPng = solidPngBytes(1, 1, [255, 0, 0, 255]);
        const secondPng = solidPngBytes(1, 1, [0, 255, 0, 255]);
        const firstBase64 = firstPng.toString("base64");
        const secondBase64 = secondPng.toString("base64");
        const first = await saveGeneratedImage({
            sessionId: "session/1",
            toolCallId: "call/1",
            index: 0,
            base64: firstBase64,
            agentDir,
        });
        const second = await saveGeneratedImage({
            sessionId: "session/1",
            toolCallId: "call*1",
            index: 0,
            base64: secondBase64,
            agentDir,
        });

        assert.equal(
            first.path,
            join(agentDir, "pi-codex-core", "imagegen", "session_1", "call_1.png"),
        );
        assert.equal(
            second.path,
            join(agentDir, "pi-codex-core", "imagegen", "session_1", "call_1-2.png"),
        );
        assert.deepEqual(await readFile(first.absolutePath), firstPng);
        assert.deepEqual(await readFile(second.absolutePath), secondPng);
        assert.deepEqual(await readFile(second.latestAbsolutePath), secondPng);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

function makeImageContext(cwd: string): ExtensionContext {
    const ctx = {
        cwd,
        model: {
            provider: "openai-codex",
            api: "openai-codex-responses",
            id: "gpt-5.5",
            baseUrl: "https://chatgpt.com/backend-api",
            input: ["text", "image"],
        },
        sessionManager: {
            getSessionId: () => "session/1",
        },
    };
    // SAFETY: This test only exercises cwd, model image support, and session id lookup.
    return ctx as unknown as ExtensionContext;
}

function makeWebRunContext(cwd: string): ExtensionContext {
    const ctx = {
        cwd,
        model: {
            provider: "openai-codex",
            api: "openai-codex-responses",
            id: "gpt-5.5",
            baseUrl: "https://chatgpt.com/backend-api",
        },
        modelRegistry: {
            getApiKeyAndHeaders: async () => ({
                ok: true,
                apiKey: "token",
                headers: { "chatgpt-account-id": "account" },
            }),
        },
        sessionManager: {
            getSessionId: () => "session/1",
            getBranch: () => [],
        },
    };
    // SAFETY: This test exercises web_run execution fields only.
    return ctx as unknown as ExtensionContext;
}

function makeWebRunContextWithBranch(
    cwd: string,
    branchEntries: readonly Record<string, unknown>[],
): ExtensionContext {
    const base = makeWebRunContext(cwd);
    const ctx = {
        ...base,
        sessionManager: {
            getSessionId: () => "session/1",
            getBranch: () => branchEntries,
        },
    };
    // SAFETY: This test context changes only the session branch fixture used by image lookup.
    return ctx as unknown as ExtensionContext;
}

function solidPngBytes(
    width: number,
    height: number,
    rgba: readonly [number, number, number, number],
): Buffer {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;
    for (let pixelOffset = 1; pixelOffset < row.length; pixelOffset += 4) {
        row[pixelOffset] = rgba[0];
        row[pixelOffset + 1] = rgba[1];
        row[pixelOffset + 2] = rgba[2];
        row[pixelOffset + 3] = rgba[3];
    }
    const raw = Buffer.alloc(row.length * height);
    for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
        row.copy(raw, rowIndex * row.length);
    }

    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    header[10] = 0;
    header[11] = 0;
    header[12] = 0;

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk("IHDR", header),
        pngChunk("IDAT", deflateSync(raw)),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBytes = Buffer.from(type, "ascii");
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
    return Buffer.concat([length, typeBytes, data, checksum]);
}

const CRC32_TABLE = makeCrc32Table();

function makeCrc32Table(): Uint32Array {
    const table = new Uint32Array(256);
    for (let tableIndex = 0; tableIndex < table.length; tableIndex += 1) {
        let value = tableIndex;
        for (let bitIndex = 0; bitIndex < 8; bitIndex += 1) {
            value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        table[tableIndex] = value;
    }
    return table;
}

function crc32(bytes: Buffer): number {
    let value = 0xffffffff;
    for (const byte of bytes) {
        value = (value >>> 8) ^ (CRC32_TABLE[(value ^ byte) & 0xff] ?? 0);
    }
    return Uint32Array.of(value ^ 0xffffffff)[0] ?? 0;
}
