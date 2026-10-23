import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "vitest";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { normalizeRegisteredCommand } from "../src/command/registered-command.ts";
import { createTypedCommandRegistry } from "../src/registry.ts";
import { typedSkillCommandFromMetadata } from "../src/skills/command.ts";
import type { RegisteredTypedCommand } from "../src/pi/command-types.ts";
import { TypedCommandUxSession } from "../src/pi/ux-session.ts";
import {
    createTestExtensionApi,
    createTestExtensionContext,
    createTestTheme,
    createTestTui,
    requireTestWidgetFactory,
    type TestWidgetFactory,
} from "./pi-test-adapter.ts";

function isAutocompleteProviderFactory(
    value: unknown,
): value is (current: AutocompleteProvider) => AutocompleteProvider {
    return typeof value === "function";
}

type SessionHarness = {
    readonly ctx: ReturnType<typeof createTestExtensionContext>;
    readonly editorUpdates: string[];
    readonly notifications: Array<{ message: string; level: string | undefined }>;
    readonly inputTitles: string[];
    readonly selectedOptions: Array<{ title: string; options: readonly string[] }>;
    getTerminalInput(): ((data: string) => { consume?: boolean } | undefined) | undefined;
};

function createSessionHarness(
    initialEditorText: string,
    inputs: Array<string | undefined> = [],
    selections: Array<string | undefined> = [],
): SessionHarness {
    let editorText = initialEditorText;
    let terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
    const editorUpdates: string[] = [];
    const notifications: Array<{ message: string; level: string | undefined }> = [];
    const inputTitles: string[] = [];
    const selectedOptions: Array<{ title: string; options: readonly string[] }> = [];
    const ctx = createTestExtensionContext({
        mode: "rpc",
        ui: {
            getEditorText: () => editorText,
            async input(title) {
                inputTitles.push(title);
                return Promise.resolve(inputs.shift());
            },
            notify(message, level) {
                notifications.push({ message, level });
            },
            onTerminalInput(handler) {
                terminalInput = handler;

                return () => {
                    terminalInput = undefined;
                };
            },
            async select(title, options) {
                selectedOptions.push({ title, options });
                return Promise.resolve(selections.shift());
            },
            setEditorText(value) {
                editorText = value;
                editorUpdates.push(value);
            },
        },
    });

    return {
        ctx,
        editorUpdates,
        notifications,
        inputTitles,
        selectedOptions,
        getTerminalInput: () => terminalInput,
    };
}

describe("typed command UX session", () => {
    it.each(["Error", "non-Error"])(
        "queues both safe detached-failure records when notify throws (%s), without terminal output",
        (kind) => {
            const directory = mkdtempSync(join(tmpdir(), "typed-command-diagnostics-"));
            try {
                const result = spawnSync(
                    process.execPath,
                    [
                        "--import",
                        import.meta.resolve("tsx"),
                        "--input-type=module",
                        "-e",
                        `
                        import assert from "node:assert/strict";
                        import { bindExtensionDiagnostics, reportExtensionDiagnostic } from "@zigai/pi-extension-internals";
                        import { normalizeRegisteredCommand } from ${JSON.stringify(new URL("../src/command/registered-command.ts", import.meta.url).href)};
                        import { createTypedCommandRegistry } from ${JSON.stringify(new URL("../src/registry.ts", import.meta.url).href)};
                        import { TypedCommandUxSession } from ${JSON.stringify(new URL("../src/pi/ux-session.ts", import.meta.url).href)};
                        import { createTestExtensionApi, createTestExtensionContext, createTestSignal } from ${JSON.stringify(new URL("./pi-test-adapter.ts", import.meta.url).href)};

                        const registry = createTypedCommandRegistry();
                        registry.register(normalizeRegisteredCommand({
                            name: "diagnostic-form", description: "Failure demo",
                            args: { token: { type: "string", required: true, sensitive: true } },
                            run() {},
                        }));
                        const failure = () => {
                            if (${JSON.stringify(kind)} === "Error") return new Error("SECRET error cause");
                            return { secret: "SECRET arbitrary cause" };
                        };
                        let terminalInput;
                        const attempts = [];
                        const broken = createTestExtensionContext({
                            ui: {
                                getEditorText: () => "/diagnostic-form",
                                onTerminalInput(handler) { terminalInput = handler; return () => {}; },
                                async custom() { throw failure(); },
                                notify(message) { attempts.push(message); throw failure(); },
                            },
                        });
                        const session = new TypedCommandUxSession(createTestExtensionApi(), {}, registry);
                        await session.start(broken);
                        assert.deepEqual(terminalInput("\\t"), { consume: true });
                        await session.waitForFormCompletion();
                        assert.equal(attempts[0], "Typed command form failed.");
                        await session.stop();

                        const notices = [];
                        const healthy = createTestExtensionContext({
                            ui: { notify(message, level) { notices.push({ message, level }); } },
                        });
                        await session.start(healthy);
                        reportExtensionDiagnostic("Standalone transport active", "info");
                        assert.deepEqual(notices, [
                            { message: "pi-typed-args detached form task failed (${kind})", level: "error" },
                            { message: "pi-typed-args failed to report detached form task error (${kind})", level: "error" },
                            { message: "Standalone transport active", level: "info" },
                        ]);
                        await session.stop();

                        const opened = createTestSignal();
                        const release = createTestSignal();
                        const closing = createTestExtensionContext({
                            ui: {
                                getEditorText: () => "/diagnostic-form",
                                onTerminalInput(handler) { terminalInput = handler; return () => {}; },
                                notify: healthy.ui.notify,
                                async custom() {
                                    opened.resolve();
                                    await release.promise;
                                    reportExtensionDiagnostic("Owned form cleanup", "info");
                                    throw failure();
                                },
                            },
                        });
                        await session.start(closing);
                        terminalInput("\\t");
                        await opened.promise;
                        const stopped = session.stop();
                        release.resolve();
                        await stopped;
                        // Cleanup retains its transport, but the stale form rejection is silent.
                        assert.deepEqual(notices.slice(3), [{ message: "Owned form cleanup", level: "info" }]);
                        await session.stop();
                        reportExtensionDiagnostic("After shutdown", "warning");
                        assert.equal(notices.length, 4);
                        const rebound = bindExtensionDiagnostics(healthy);
                        assert.deepEqual(notices.at(-1), { message: "After shutdown", level: "warning" });
                        rebound.dispose();
                        `,
                    ],
                    {
                        cwd: import.meta.dirname,
                        encoding: "utf8",
                        env: { ...process.env, PI_CODING_AGENT_DIR: directory },
                        timeout: 15_000,
                    },
                );
                assert.equal(result.status, 0, result.stderr);
                assert.equal(result.stderr, "");
                assert.equal(result.stdout, "");
            } finally {
                rmSync(directory, { recursive: true, force: true });
            }
        },
    );

    it("shows description-only command coverage without inventing forms or retaining stale helpers", async () => {
        const directory = mkdtempSync(join(tmpdir(), "command-description-"));
        const previous = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = directory;
        mkdirSync(join(directory, "pi-typed-args"));
        writeFileSync(
            join(directory, "pi-typed-args/config.json"),
            JSON.stringify({ appearance: { style: "contextual" } }),
        );
        let text = "/sample";
        let widget: TestWidgetFactory | undefined;
        let terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
        const ctx = createTestExtensionContext({
            cwd: directory,
            ui: {
                getEditorText: () => text,
                setWidget(_key, value) {
                    if (value === undefined) widget = undefined;
                    else widget = requireTestWidgetFactory(value);
                },
                onTerminalInput(handler) {
                    terminalInput = handler;

                    return () => {
                        terminalInput = undefined;
                    };
                },
            },
        });
        const pi = createTestExtensionApi({
            getCommands: () => [
                {
                    name: "sample",
                    description: "Describe the sample",
                    source: "extension",
                    sourceInfo: {
                        path: join(directory, "sample.ts"),
                        source: "test",
                        scope: "temporary",
                        origin: "top-level",
                    },
                },
            ],
        });
        const session = new TypedCommandUxSession(pi, {}, createTypedCommandRegistry());
        try {
            await session.start(ctx);
            assert.ok(widget);
            assert.match(
                widget(createTestTui(), createTestTheme()).render(80).join("\n"),
                /Describe the sample/,
            );
            assert.match(
                widget(createTestTui(), createTestTheme()).render(80).join("\n"),
                /Argument metadata unavailable/,
            );
            assert.ok(terminalInput);
            assert.equal(terminalInput("\t"), undefined);
            text = "/settings";
            await session.start(ctx);
            assert.equal(widget, undefined);
        } finally {
            await session.stop();

            if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previous;

            rmSync(directory, { recursive: true });
        }
    });

    it.each([
        ["missing", "/workspace"],
        ["unknown", "/workspace typo"],
    ])(
        "selects a subcommand for %s input, collects values, and writes the invocation",
        async (_route, editorText) => {
            const registry = createTypedCommandRegistry();
            const command = normalizeRegisteredCommand({
                name: "workspace",
                description: "Manage workspaces",
                args: {},
                run() {},
                subcommands: {
                    create: {
                        description: "Create a workspace",
                        args: { path: { type: "string", required: true } },
                        run() {},
                    },
                    remove: {
                        description: "Remove a workspace",
                        args: { force: { type: "boolean" } },
                        run() {},
                    },
                },
            });
            registry.register(command);
            const harness = createSessionHarness(editorText, ["demo"], ["create"]);
            const session = new TypedCommandUxSession(createTestExtensionApi(), {}, registry);

            try {
                await session.start(harness.ctx);
                const terminalInput = harness.getTerminalInput();
                assert.ok(terminalInput);
                assert.deepEqual(terminalInput("\t"), { consume: true });
                await session.waitForFormCompletion();

                assert.deepEqual(harness.selectedOptions, [
                    {
                        title: "Select subcommand",
                        options: ["(root command)", "create", "remove"],
                    },
                ]);
                assert.deepEqual(harness.inputTitles, ["Set --path (current: )"]);
                assert.deepEqual(harness.editorUpdates, ["/workspace create --path=demo"]);
            } finally {
                await session.stop();
                registry.unregister(command);
            }
        },
    );

    it("serves typed suggestions through the installed editor completion bridge", async () => {
        const registry = createTypedCommandRegistry();
        let asyncCalls = 0;
        const command = normalizeRegisteredCommand({
            name: "bridge-completion",
            description: "Test editor completion",
            args: {
                environment: { type: "enum", values: ["dev", "prod"] },
                remote: {
                    type: "string",
                    async completeAsync() {
                        asyncCalls += 1;
                        return [];
                    },
                },
            },
            run() {},
        });
        registry.register(command);
        let providerFactory: ((current: AutocompleteProvider) => AutocompleteProvider) | undefined;
        let terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
        const editorText = "/bridge-completion --environment d";
        const ctx = createTestExtensionContext({
            ui: {
                addAutocompleteProvider(factory) {
                    if (!isAutocompleteProviderFactory(factory)) {
                        assert.fail("expected an autocomplete provider factory");
                    }

                    providerFactory = factory;
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
            },
        });
        const session = new TypedCommandUxSession(createTestExtensionApi(), {}, registry);
        const base: AutocompleteProvider = {
            async getSuggestions() {
                return null;
            },
            applyCompletion(lines, cursorLine, cursorCol) {
                return { lines, cursorLine, cursorCol };
            },
        };

        try {
            await session.start(ctx);
            assert.ok(providerFactory);
            const provider = providerFactory(base);
            const suggestions = await provider.getSuggestions([editorText], 0, editorText.length, {
                signal: new AbortController().signal,
            });

            assert.equal(suggestions?.prefix, "d");
            assert.deepEqual(
                suggestions?.items.map((item) => item.value),
                ["dev"],
            );
            assert.ok(terminalInput);
            assert.equal(terminalInput("\t"), undefined);
            const request = new AbortController();
            request.abort();
            const remoteText = "/bridge-completion --remote x";
            await provider.getSuggestions([remoteText], 0, remoteText.length, {
                signal: request.signal,
            });
            assert.equal(asyncCalls, 0);
        } finally {
            await session.stop();
            registry.unregister(command);
        }
    });

    it("renders a typed skill form into a user message and clears the editor", async () => {
        const registry = createTypedCommandRegistry();
        const command = typedSkillCommandFromMetadata({
            name: "inspect-files",
            description: "Inspect files",
            filePath: join(process.cwd(), "SKILL.md"),
            baseDir: process.cwd(),
            args: { path: { type: "string", required: true } },
            body: "Inspect {args.path}.",
        });
        registry.register(command);
        const harness = createSessionHarness("/skill:inspect-files", ["src"]);
        const messages: unknown[] = [];
        const session = new TypedCommandUxSession(
            createTestExtensionApi({
                sendUserMessage(message) {
                    messages.push(message);
                },
            }),
            {},
            registry,
        );

        try {
            await session.start(harness.ctx);
            const terminalInput = harness.getTerminalInput();
            assert.ok(terminalInput);
            assert.deepEqual(terminalInput("\t"), { consume: true });
            await session.waitForFormCompletion();
            assert.deepEqual(harness.inputTitles, ["Set --path (current: )"]);
            assert.deepEqual(harness.editorUpdates, [""]);
            assert.equal(messages.length, 1);
            assert.equal(typeof messages[0], "string");

            if (typeof messages[0] !== "string") {
                assert.fail("expected a rendered skill message");
            }

            assert.match(messages[0], /<skill name="inspect-files"/);
            assert.match(messages[0], /Inspect "src"\./);
        } finally {
            await session.stop();
            registry.unregister(command);
        }
    });

    it("reports commands without extension handlers after collecting their form values", async () => {
        const registry = createTypedCommandRegistry();
        const command: RegisteredTypedCommand = {
            name: "orphan",
            description: "Orphan command",
            args: { path: { type: "string", required: true } },
            formSymbols: {
                selectedCheckbox: "■",
                unselectedCheckbox: "□",
                selectedRadio: "●",
                unselectedRadio: "○",
            },
        };
        registry.register(command);
        const harness = createSessionHarness("/orphan", ["src"]);
        const session = new TypedCommandUxSession(createTestExtensionApi(), {}, registry);

        try {
            await session.start(harness.ctx);
            const terminalInput = harness.getTerminalInput();
            assert.ok(terminalInput);
            assert.deepEqual(terminalInput("\t"), { consume: true });
            await session.waitForFormCompletion();
            assert.deepEqual(harness.editorUpdates, []);
            assert.deepEqual(harness.notifications, [
                { message: "• path is required", level: "warning" },
                {
                    message: "Typed command /orphan does not have an extension handler.",
                    level: "error",
                },
            ]);
        } finally {
            await session.stop();
            registry.unregister(command);
        }
    });

    it("ignores Tab when the editor does not contain a registered typed command", async () => {
        const registry = createTypedCommandRegistry();
        const harness = createSessionHarness("ordinary text");
        const session = new TypedCommandUxSession(createTestExtensionApi(), {}, registry);

        try {
            await session.start(harness.ctx);
            const terminalInput = harness.getTerminalInput();
            assert.ok(terminalInput);
            assert.equal(terminalInput("\t"), undefined);
            await session.waitForFormCompletion();
            assert.deepEqual(harness.editorUpdates, []);
            assert.deepEqual(harness.notifications, []);
        } finally {
            await session.stop();
        }
    });
});
