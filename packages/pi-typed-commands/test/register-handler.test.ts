import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, it } from "vitest";
import { registerTypedCommand } from "../src/pi/register.js";
import { createTestExtensionApi, createTestExtensionCommandContext } from "./pi-test-adapter.js";

type CapturedRegistration = {
    readonly handler: (rawArgs: string, ctx: ExtensionCommandContext) => Promise<void>;
    readonly dispose: () => void;
};

function valueText(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    return JSON.stringify(value) ?? "";
}

function captureRegistration(
    definition: Parameters<typeof registerTypedCommand>[1],
): CapturedRegistration {
    let handler: ((rawArgs: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const handle = registerTypedCommand(
        createTestExtensionApi({
            registerCommand(_name, options) {
                handler = options.handler;
            },
        }),
        definition,
    );
    if (handler === undefined) {
        handle.dispose();
        throw new Error("expected Pi registration handler");
    }
    return { handler, dispose: () => handle.dispose() };
}

describe("registered typed command handler", () => {
    it("opens an always-policy form and forwards the caller signal to the prompt", async () => {
        const received: string[] = [];
        const registration = captureRegistration({
            name: "always-policy-handler-test",
            description: "Always form policy",
            formPolicy: "always",
            args: { value: { type: "string" } },
            run(args) {
                received.push(valueText(args.value));
            },
        });
        const controller = new AbortController();
        let promptSignal: AbortSignal | undefined;
        const notifications: string[] = [];
        const ctx = createTestExtensionCommandContext({
            mode: "rpc",
            signal: controller.signal,
            ui: {
                input(_title, _placeholder, options) {
                    promptSignal = options?.signal;
                    return Promise.resolve("from form");
                },
                notify(message) {
                    notifications.push(message);
                },
            },
        });

        try {
            await registration.handler("", ctx);
            assert.deepEqual(received, ["from form"]);
            assert.equal(promptSignal, controller.signal);
            assert.deepEqual(notifications, []);
        } finally {
            registration.dispose();
        }
    });

    it("uses the invalid-policy form to repair an invalid value before running", async () => {
        const received: number[] = [];
        const notifications: Array<{ message: string; level: string | undefined }> = [];
        const registration = captureRegistration({
            name: "invalid-policy-handler-test",
            description: "Invalid form policy",
            formPolicy: "invalid",
            args: { count: { type: "number", integer: true } },
            run(args) {
                received.push(Number(args.count));
            },
        });
        const ctx = createTestExtensionCommandContext({
            mode: "rpc",
            ui: {
                input() {
                    return Promise.resolve("2");
                },
                notify(message, level) {
                    notifications.push({ message, level });
                },
            },
        });

        try {
            await registration.handler("--count 1.5", ctx);
            assert.deepEqual(received, [2]);
            assert.deepEqual(notifications, [
                { message: "• count expects an integer", level: "warning" },
            ]);
        } finally {
            registration.dispose();
        }
    });

    it("keeps manual-policy failures in the editor and avoids running the handler", async () => {
        let handlerRuns = 0;
        const editorUpdates: string[] = [];
        const widgetUpdates: unknown[] = [];
        const registration = captureRegistration({
            name: "manual-policy-handler-test",
            description: "Manual form policy",
            formPolicy: "manual",
            args: { count: { type: "number" } },
            run() {
                handlerRuns += 1;
            },
        });
        const ctx = createTestExtensionCommandContext({
            mode: "rpc",
            ui: {
                setEditorText(text) {
                    editorUpdates.push(text);
                },
                setWidget(_key, value) {
                    widgetUpdates.push(value);
                },
            },
        });

        try {
            await registration.handler("--count not-a-number", ctx);
            assert.equal(handlerRuns, 0);
            assert.deepEqual(editorUpdates, ["/manual-policy-handler-test --count not-a-number"]);
            assert.equal(widgetUpdates.length, 1);
            assert.notEqual(widgetUpdates[0], undefined);
        } finally {
            registration.dispose();
        }
    });

    it("notifies directly when missing required values cannot open a form", async () => {
        const notifications: Array<{ message: string; level: string | undefined }> = [];
        const registration = captureRegistration({
            name: "no-ui-handler-test",
            description: "No UI fallback",
            args: { path: { type: "string", required: true } },
            run() {
                throw new Error("handler should not run");
            },
        });
        const ctx = createTestExtensionCommandContext({
            hasUI: false,
            mode: "print",
            ui: {
                notify(message, level) {
                    notifications.push({ message, level });
                },
            },
        });

        try {
            await registration.handler("", ctx);
            assert.deepEqual(notifications, [{ message: "--path is required", level: "error" }]);
        } finally {
            registration.dispose();
        }
    });

    it("selects a subcommand before opening its form and dispatching its handler", async () => {
        const received: string[] = [];
        const selected: Array<{ title: string; options: readonly string[] }> = [];
        const registration = captureRegistration({
            name: "select-subcommand-handler-test",
            description: "Subcommand selection",
            args: {},
            subcommands: {
                inspect: {
                    description: "Inspect",
                    args: { path: { type: "string", required: true } },
                    run(args) {
                        received.push(valueText(args.path));
                    },
                },
            },
        });
        const ctx = createTestExtensionCommandContext({
            mode: "rpc",
            ui: {
                select(title, options) {
                    selected.push({ title, options });
                    return Promise.resolve("inspect");
                },
                input() {
                    return Promise.resolve("src");
                },
            },
        });

        try {
            await registration.handler("", ctx);
            assert.deepEqual(selected, [{ title: "Select subcommand", options: ["inspect"] }]);
            assert.deepEqual(received, ["src"]);
        } finally {
            registration.dispose();
        }
    });

    it("does not dispatch when subcommand selection is cancelled", async () => {
        let handlerRuns = 0;
        const registration = captureRegistration({
            name: "cancel-subcommand-handler-test",
            description: "Cancelled selection",
            args: {},
            subcommands: {
                inspect: {
                    description: "Inspect",
                    args: {},
                    run() {
                        handlerRuns += 1;
                    },
                },
            },
        });
        const ctx = createTestExtensionCommandContext({
            mode: "rpc",
            ui: {
                select: async () => undefined,
            },
        });

        try {
            await registration.handler("", ctx);
            assert.equal(handlerRuns, 0);
        } finally {
            registration.dispose();
        }
    });
});
