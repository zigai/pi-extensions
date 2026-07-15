import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineTypedCommand } from "../src/command/definition.js";
import { installTypedCommandUx } from "../src/pi/extension.js";
import { registerTypedCommand } from "../src/pi/register.js";
import { getPiTypedCommandRegistry } from "../src/pi/registry.js";
import {
    registerSubmittedInvalidCommandHandler,
    stageExpandedFormArguments,
} from "../src/pi/session-state.js";
import { resolveTypedCommandUxOptions } from "../src/pi/settings.js";
import { TypedCommandUxSession } from "../src/pi/ux-session.js";
import { createTypedCommandRegistry } from "../src/registry.js";
import type { RegisteredTypedCommand } from "../src/pi/command-types.js";
import {
    createTestExtensionApi,
    createTestExtensionCommandContext,
    createTestExtensionContext,
} from "./pi-test-adapter.js";

describe("Pi form-only arguments", () => {
    it("delivers staged expanded-form values exactly once to the registered handler", async () => {
        let commandHandler:
            | ((rawArgs: string, ctx: ExtensionCommandContext) => Promise<void>)
            | undefined;
        const pi = createTestExtensionApi({
            registerCommand(
                _name: string,
                options: {
                    handler: (rawArgs: string, ctx: ExtensionCommandContext) => Promise<void>;
                },
            ) {
                commandHandler = options.handler;
            },
        });
        const received: Array<Record<string, unknown>> = [];
        const command = defineTypedCommand({
            name: "form-only-staging-test",
            description: "Test form-only staging",
            args: {
                task: { type: "string", position: 0, rest: true },
                maximumTimeMinutes: {
                    type: "number",
                    integer: true,
                    min: 1,
                    formOnly: true,
                },
            },
            run(args) {
                received.push(args);
            },
        });
        const handle = registerTypedCommand(pi, command);
        const ctx = createTestExtensionCommandContext({
            cwd: process.cwd(),
            hasUI: false,
            isProjectTrusted: () => false,
            mode: "print",
            ui: { notify() {}, setEditorText() {} },
        });
        const cleanup = registerSubmittedInvalidCommandHandler(
            ctx,
            resolveTypedCommandUxOptions(),
            () => {},
        );

        try {
            const editorText = `/${handle.invocationName} "Build and verify"`;
            assert.equal(
                stageExpandedFormArguments(ctx, handle.invocationName, editorText, {
                    task: "Build and verify",
                    maximumTimeMinutes: 60,
                }),
                true,
            );
            assert.ok(commandHandler);

            await commandHandler('"Build and verify"', ctx);
            await commandHandler('"Build and verify"', ctx);

            assert.deepEqual(received, [
                { task: "Build and verify", maximumTimeMinutes: 60 },
                { task: "Build and verify" },
            ]);
        } finally {
            cleanup();
            handle.dispose();
        }
    });

    it("opens the expanded form only after two consecutive Tabs on unchanged text", async () => {
        const registry = createTypedCommandRegistry();
        const command: RegisteredTypedCommand = {
            name: "double-tab-form-test",
            description: "Test double Tab",
            args: {
                task: { type: "string", position: 0, rest: true },
                maximumTimeMinutes: { type: "number", formOnly: true },
            },
            formSymbols: {
                selectedCheckbox: "■",
                unselectedCheckbox: "□",
                selectedRadio: "●",
                unselectedRadio: "○",
            },
            target: { kind: "extension", run() {} },
        };
        registry.register(command);

        let terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
        let customCalls = 0;
        let editorText = "/double-tab-form-test Build";
        const pi = createTestExtensionApi();
        const ctx = createTestExtensionContext({
            cwd: process.cwd(),
            hasUI: true,
            isProjectTrusted: () => false,
            mode: "tui",
            ui: {
                addAutocompleteProvider() {},
                custom: async () => {
                    customCalls += 1;
                    return undefined;
                },
                getEditorText: () => editorText,
                notify() {},
                onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined) {
                    terminalInput = handler;
                    return () => {
                        terminalInput = undefined;
                    };
                },
                setEditorText(value: string) {
                    editorText = value;
                },
                setWidget() {},
            },
        });
        const session = new TypedCommandUxSession(pi, { formTrigger: "double-tab" }, registry);

        try {
            await session.start(ctx);
            assert.ok(terminalInput);

            assert.deepEqual(terminalInput("\t"), { consume: true });
            assert.equal(customCalls, 0);

            terminalInput("x");
            assert.deepEqual(terminalInput("\t"), { consume: true });
            assert.equal(customCalls, 0);

            assert.deepEqual(terminalInput("\t"), { consume: true });
            await session.waitForFormCompletion();
            assert.equal(customCalls, 1);
        } finally {
            await session.stop();
        }
    });

    it("deduplicates composed UX installs and merges a later double-Tab trigger", async () => {
        const command: RegisteredTypedCommand = {
            name: "deduplicated-double-tab-form-test",
            description: "Test composed double Tab",
            args: {
                task: { type: "string", position: 0, rest: true },
            },
            formSymbols: {
                selectedCheckbox: "■",
                unselectedCheckbox: "□",
                selectedRadio: "●",
                unselectedRadio: "○",
            },
            target: { kind: "extension", run() {} },
        };
        const registry = getPiTypedCommandRegistry();
        registry.register(command);

        const firstHandlers = new Map<
            string,
            Array<(event: unknown, ctx: ExtensionContext) => unknown>
        >();
        const secondHandlers = new Map<
            string,
            Array<(event: unknown, ctx: ExtensionContext) => unknown>
        >();
        let terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
        let customCalls = 0;
        const editorText = "/deduplicated-double-tab-form-test Build";
        const sharedEvents = createTestExtensionApi().events;
        const firstPi = createTestExtensionApi({
            events: sharedEvents,
            on(name, handler) {
                const current = firstHandlers.get(name) ?? [];
                firstHandlers.set(name, [...current, handler]);
            },
        });
        const secondPi = createTestExtensionApi({
            events: sharedEvents,
            on(name, handler) {
                const current = secondHandlers.get(name) ?? [];
                secondHandlers.set(name, [...current, handler]);
            },
        });
        const ctx = createTestExtensionContext({
            cwd: process.cwd(),
            hasUI: true,
            isProjectTrusted: () => false,
            mode: "tui",
            ui: {
                addAutocompleteProvider() {},
                custom: async () => {
                    customCalls += 1;
                    return undefined;
                },
                getEditorText: () => editorText,
                notify() {},
                onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined) {
                    terminalInput = handler;
                    return () => {
                        terminalInput = undefined;
                    };
                },
                setEditorText() {},
                setWidget() {},
            },
        });

        installTypedCommandUx(firstPi);
        installTypedCommandUx(secondPi, { formTrigger: "double-tab" });

        try {
            assert.equal(firstHandlers.get("session_start")?.length, 1);
            assert.equal(firstHandlers.get("input")?.length, 1);
            assert.equal(firstHandlers.get("session_shutdown")?.length, 1);
            assert.equal(secondHandlers.size, 0);

            const start = firstHandlers.get("session_start")?.[0];
            assert.ok(start);
            await start({}, ctx);
            assert.ok(terminalInput);

            assert.deepEqual(terminalInput("\t"), { consume: true });
            assert.equal(customCalls, 0);
            assert.deepEqual(terminalInput("\t"), { consume: true });
            await Promise.resolve();
            assert.equal(customCalls, 1);
        } finally {
            const shutdown = firstHandlers.get("session_shutdown")?.[0];
            if (shutdown !== undefined) {
                await shutdown({}, ctx);
            }
            registry.unregister(command);
        }
    });
});
