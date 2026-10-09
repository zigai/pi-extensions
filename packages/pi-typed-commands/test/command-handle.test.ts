import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { defineTypedCommand } from "../src/command/definition.js";
import { registerTypedCommand } from "../src/pi/register.js";
import { createTestExtensionApi } from "./pi-test-adapter.js";

describe("typed command registration handle", () => {
    it("exposes parse, serialization, usage, help, and subcommand helpers", () => {
        const command = defineTypedCommand({
            name: "handle-api-test",
            description: "Exercise the command handle API",
            args: { verbose: { type: "boolean" } },
            run() {},
            subcommands: {
                inspect: {
                    description: "Inspect a path",
                    args: { path: { type: "string", required: true } },
                    run() {},
                },
            },
        });
        const handle = registerTypedCommand(createTestExtensionApi(), command);

        try {
            assert.equal(Object.isFrozen(handle), true);
            assert.equal(handle.invocationName, "handle-api-test");
            assert.equal(handle.parse("--verbose").status, "success");
            assert.equal(handle.serialize({ verbose: true }), "--verbose");
            assert.equal(
                handle.serializeSubcommand({
                    subcommand: "inspect",
                    args: { path: "src" },
                }),
                "inspect --path=src",
            );
            assert.match(handle.formatUsage(), /\/handle-api-test/);
            assert.match(handle.formatHelp(), /Exercise the command handle API/);
        } finally {
            handle.dispose();
        }
    });
});
