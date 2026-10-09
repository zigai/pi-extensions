import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import extension from "../src/index.ts";
import { loadMentionAnythingSettings } from "../src/settings.ts";
import { createConfiguredProvider } from "../src/configured-source.ts";
import { mentionAnythingSettingsSchema } from "../src/settings-input.ts";

type Payload =
    | { readonly type: "session_start" | "session_shutdown" }
    | { readonly messages: ContextEvent["messages"] };
type Result = { readonly messages: ContextEvent["messages"] } | undefined;
type TestContext = {
    readonly cwd: string;
    readonly hasUI: boolean;
    isProjectTrusted(): boolean;
    readonly ui: { notify(message: string): void };
};
type Handler = (payload: Payload, ctx: TestContext) => Promise<Result> | Result;

function isHandler(value: unknown): value is Handler {
    return typeof value === "function";
}

test("settings entrypoint wires chaining and templates into the shared runtime", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "mention-runtime-"));
    const original = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const handlers = new Map<string, unknown>();
    const notices: string[] = [];
    const ctx: TestContext = {
        cwd: agentDir,
        hasUI: false,
        isProjectTrusted: () => true,
        ui: {
            notify(message) {
                notices.push(message);
            },
        },
    };
    const pi: Pick<ExtensionAPI, "on"> = {
        on(event, handler) {
            handlers.set(event, handler);

            return () => {};
        },
    };
    const invoke = async (event: string, payload: Payload): Promise<Result> => {
        const handler = handlers.get(event);
        if (!isHandler(handler)) throw new Error("Missing event handler.");
        return handler(payload, ctx);
    };
    try {
        await mkdir(join(agentDir, "extension-settings"));
        await writeFile(
            join(agentDir, "extension-settings", "pi-mention-anything.json"),
            JSON.stringify({
                mentions: [
                    {
                        id: "targets",
                        trigger: "target:",
                        separator: ":",
                        replacementTemplate: "Target {{id}} at {{path}}",
                        source: {
                            type: "static",
                            items: [
                                { id: "one", name: "team", navigable: true },
                                { id: "two", name: "api", parentPath: ["one"] },
                            ],
                        },
                    },
                ],
            }),
        );
        Value.Parse(
            mentionAnythingSettingsSchema,
            JSON.parse(
                await readFile(
                    join(agentDir, "extension-settings", "pi-mention-anything.json"),
                    "utf8",
                ),
            ),
        );
        const configuredMentions = loadMentionAnythingSettings(ctx).mentions;
        assert.equal(configuredMentions.length, 1);
        const configured = configuredMentions[0];
        assert.equal(configured.separator, ":");
        assert.equal(
            (
                await createConfiguredProvider(configured, ctx.cwd).resolve({
                    sourceId: "targets",
                    cwd: ctx.cwd,
                    trusted: true,
                    segments: ["team", "api"],
                    signal: new AbortController().signal,
                })
            ).status,
            "resolved",
        );

        extension(pi);
        await invoke("session_start", { type: "session_start" });
        const result = await invoke("context", {
            messages: [{ role: "user", content: "target:team:api", timestamp: 123 }],
        });
        assert.deepEqual(result, {
            messages: [{ role: "user", content: "Target two at team:api", timestamp: 123 }],
        });
        assert.deepEqual(notices, []);
        await invoke("session_shutdown", { type: "session_shutdown" });
        assert.equal(
            await invoke("context", {
                messages: [{ role: "user", content: "target:team:api", timestamp: 124 }],
            }),
            undefined,
        );
        await invoke("session_start", { type: "session_start" });
        assert.deepEqual(
            await invoke("context", {
                messages: [{ role: "user", content: "target:team:api", timestamp: 125 }],
            }),
            { messages: [{ role: "user", content: "Target two at team:api", timestamp: 125 }] },
        );
    } finally {
        if (handlers.has("session_shutdown"))
            await invoke("session_shutdown", { type: "session_shutdown" });

        if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = original;

        await rm(agentDir, { recursive: true, force: true });
    }
});
