import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "vitest";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { normalizeRegisteredCommand } from "../src/command/registered-command.js";
import { createTypedCommandRegistry } from "../src/registry.js";
import { typedSkillCommandFromMetadata } from "../src/skills/command.js";
import type { RegisteredTypedCommand } from "../src/pi/command-types.js";
import { TypedCommandUxSession } from "../src/pi/ux-session.js";
import { createTestExtensionApi, createTestExtensionContext } from "./pi-test-adapter.js";

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
            input(title) {
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
            select(title, options) {
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
