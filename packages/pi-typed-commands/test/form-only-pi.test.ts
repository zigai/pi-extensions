import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "vitest";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineTypedCommand } from "../src/command/definition.js";
import { installTypedCommandUx } from "../src/pi/extension.js";
import { registerTypedCommand } from "../src/pi/register.js";
import { getPiTypedCommandRegistry } from "../src/pi/registry.js";
import {
    registerSubmittedInvalidCommandHandler,
    stageExpandedFormArguments,
    takeExpandedFormArguments,
} from "../src/pi/session-state.js";
import { resolveTypedCommandUxOptions } from "../src/pi/settings.js";
import { TypedCommandUxSession } from "../src/pi/ux-session.js";
import { createTypedCommandRegistry } from "../src/registry.js";
import type { RegisteredTypedCommand } from "../src/pi/command-types.js";
import { typedSkillCommandFromMetadata } from "../src/skills/command.js";
import {
    createTestExtensionApi,
    createTestExtensionCommandContext,
    createTestExtensionContext,
    createTestKeybindings,
    createTestSignal,
    createTestTheme,
    createTestTui,
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

    it.each(["cancellation", "shutdown", "replacement"] as const)(
        "prevents expanded extension-form side effects after %s",
        async (lifecycle) => {
            const registry = createTypedCommandRegistry();
            let handlerRuns = 0;
            const command: RegisteredTypedCommand = {
                name: `expanded-${lifecycle}-test`,
                description: "Expanded form lifecycle test",
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
                target: {
                    kind: "extension",
                    run() {
                        handlerRuns += 1;
                    },
                },
            };
            registry.register(command);

            const editorText = `/${command.name} Build`;
            const editorUpdates: string[] = [];
            const formStarted = createTestSignal<void>();
            const abortObserved = createTestSignal<void>();
            const formCompletion = createTestSignal<unknown>();
            let cancelForm: (() => void) | undefined;
            let terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
            const pi = createTestExtensionApi();
            const ctx = createTestExtensionContext({
                mode: "tui",
                ui: {
                    custom: async (factory) => {
                        const done = (value: unknown): void => {
                            if (lifecycle !== "cancellation" && value === undefined) {
                                abortObserved.resolve();
                                return;
                            }
                            formCompletion.resolve(value);
                        };
                        await factory(
                            createTestTui(),
                            createTestTheme(),
                            createTestKeybindings(),
                            done,
                        );
                        cancelForm = () => {
                            done(undefined);
                        };
                        formStarted.resolve();
                        return formCompletion.promise;
                    },
                    getEditorText() {
                        return editorText;
                    },
                    onTerminalInput(handler) {
                        terminalInput = handler;
                        return () => {
                            terminalInput = undefined;
                        };
                    },
                    setEditorText(value) {
                        editorUpdates.push(value);
                    },
                },
            });
            const session = new TypedCommandUxSession(pi, {}, registry);

            try {
                await session.start(ctx);
                assert.ok(terminalInput);
                assert.deepEqual(terminalInput("\t"), { consume: true });
                await formStarted.promise;

                if (lifecycle === "cancellation") {
                    assert.ok(cancelForm);
                    cancelForm();
                    await session.waitForFormCompletion();
                } else if (lifecycle === "shutdown") {
                    const shutdown = session.stop();
                    await abortObserved.promise;
                    formCompletion.resolve({
                        confirmed: true,
                        state: { task: "Build", maximumTimeMinutes: 60 },
                    });
                    await shutdown;
                } else {
                    const restart = session.start(ctx);
                    await abortObserved.promise;
                    formCompletion.resolve({
                        confirmed: true,
                        state: { task: "Build", maximumTimeMinutes: 60 },
                    });
                    await restart;
                }

                assert.deepEqual(editorUpdates, []);
                assert.equal(handlerRuns, 0);
                assert.equal(takeExpandedFormArguments(ctx, command.name, editorText), undefined);
            } finally {
                await session.stop();
            }
        },
    );

    it("prevents stale skill completion from clearing or sending after session restart", async () => {
        const registry = createTypedCommandRegistry();
        const command = typedSkillCommandFromMetadata({
            name: "replacement-skill-test",
            description: "Replacement skill",
            filePath: join(process.cwd(), "SKILL.md"),
            baseDir: process.cwd(),
            args: { path: { type: "string", required: true } },
            body: "Use {args.path}.",
        });
        registry.register(command);

        const formStarted = createTestSignal<void>();
        const abortObserved = createTestSignal<void>();
        const formCompletion = createTestSignal<unknown>();
        const editorUpdates: string[] = [];
        let sentMessageCount = 0;
        let terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
        const pi = createTestExtensionApi({
            sendUserMessage() {
                sentMessageCount += 1;
            },
        });
        const ctx = createTestExtensionContext({
            mode: "tui",
            ui: {
                custom: async (factory) => {
                    await factory(
                        createTestTui(),
                        createTestTheme(),
                        createTestKeybindings(),
                        (value: unknown) => {
                            if (value === undefined) {
                                abortObserved.resolve();
                                return;
                            }
                            formCompletion.resolve(value);
                        },
                    );
                    formStarted.resolve();
                    return formCompletion.promise;
                },
                getEditorText() {
                    return "/skill:replacement-skill-test";
                },
                onTerminalInput(handler) {
                    terminalInput = handler;
                    return () => {
                        terminalInput = undefined;
                    };
                },
                setEditorText(value) {
                    editorUpdates.push(value);
                },
            },
        });
        const session = new TypedCommandUxSession(pi, {}, registry);

        try {
            await session.start(ctx);
            assert.ok(terminalInput);
            assert.deepEqual(terminalInput("\t"), { consume: true });
            await formStarted.promise;

            const restart = session.start(ctx);
            await abortObserved.promise;
            formCompletion.resolve({ confirmed: true, state: { path: "stale.txt" } });
            await restart;

            assert.deepEqual(editorUpdates, []);
            assert.equal(sentMessageCount, 0);
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
