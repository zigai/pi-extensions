import assert from "node:assert/strict";
import { test } from "vitest";
import { createConfiguredProvider } from "../src/configured-source.ts";
import type { ConfiguredMention } from "../src/settings.ts";
import { createSourceController } from "../src/source-controller.ts";

function mention(source: ConfiguredMention["source"]): ConfiguredMention {
    return {
        id: "hosts",
        trigger: "s:",
        completionSuffix: " ",
        source,
        initialSuggestions: { strategy: "frecency", pinned: [] },
    };
}

const request = {
    sourceId: "hosts",
    cwd: process.cwd(),
    trusted: true,
    query: "",
    path: [],
    limit: 100,
    signal: new AbortController().signal,
};

test("array commands have an explicit format and preserve contextual replacements", async () => {
    const provider = createConfiguredProvider(
        mention({
            type: "command",
            mode: "array",
            command: process.execPath,
            args: [
                "-e",
                "console.log(JSON.stringify([{name:'host',replacement:'SSH alias host'}]))",
            ],
        }),
        process.cwd(),
    );
    const response = await provider.discover(request);
    assert.equal(response.items[0]?.replacement, "SSH alias host");
    assert.equal(response.items[0]?.id, "host");
    const resolution = await provider.resolve({ ...request, segments: ["host"] });
    assert.equal(resolution.status, "resolved");
});

test("invalid array output is rejected without leaking stdout or stderr", async () => {
    const provider = createConfiguredProvider(
        mention({
            type: "command",
            command: process.execPath,
            args: ["-e", "console.error('secret');console.log(JSON.stringify({secret:'private'}))"],
        }),
        process.cwd(),
    );
    await assert.rejects(
        provider.discover(request),
        (cause: unknown) =>
            cause instanceof Error &&
            !cause.message.includes("secret") &&
            !cause.message.includes("private"),
    );
});

test("static tree exact resolution uses parent IDs and rejects ambiguous text", async () => {
    const provider = createConfiguredProvider(
        mention({
            type: "static",
            items: [
                { id: "$1", name: "work", navigable: true },
                { id: "@2", name: "api", parentPath: ["$1"], navigable: true },
                { id: "%3", name: "logs", parentPath: ["$1", "@2"], replacement: "tmux pane %3" },
                { id: "%4", name: "duplicate", parentPath: ["$1", "@2"] },
                { id: "%5", name: "duplicate", parentPath: ["$1", "@2"] },
            ],
        }),
        process.cwd(),
    );
    const ancestor = await provider.resolve({ ...request, segments: ["work"] });
    assert.equal(
        ancestor.status,
        "resolved",
        "nonselectable parents must resolve for child discovery",
    );
    const resolution = await provider.resolve({ ...request, segments: ["work", "api", "logs"] });
    assert.equal(resolution.status, "resolved");
    assert.deepEqual(
        resolution.path.map((item) => item.id),
        ["$1", "@2", "%3"],
    );
    assert.equal(
        (await provider.resolve({ ...request, segments: ["work", "api", "duplicate"] })).status,
        "unresolved",
    );
});

test("settings adapters pass through the shared controller and reject duplicate IDs", async () => {
    const provider = createConfiguredProvider(
        mention({
            type: "static",
            items: [
                { id: "one", name: "a" },
                { id: "one", name: "b" },
            ],
        }),
        process.cwd(),
    );
    const controller = createSourceController(provider, {
        sourceId: "hosts",
        cwd: process.cwd(),
        trusted: true,
    });
    await assert.rejects(controller.discover({ query: "", path: [] }));
    await controller.dispose();
});
