import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { CustomEditor, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
    visibleWidth,
    type AutocompleteProvider,
    type EditorComponent,
    type EditorTheme,
} from "@earendil-works/pi-tui";
import { normalizeRegisteredCommand } from "../src/command/registered-command.js";
import {
    renderGhostTextOnEditorLines,
    resolveGhostText,
    withGhostText,
} from "../src/pi/ghost-text.js";
import { TypedCommandUxSession } from "../src/pi/ux-session.js";
import { createTypedCommandRegistry } from "../src/registry.js";
import { typedSkillCommandFromMetadata } from "../src/skills/command.js";
import {
    createTestExtensionApi,
    createTestExtensionContext,
    createTestKeybindings,
    createTestTui,
    requireFocusableComponent,
} from "./pi-test-adapter.js";

const identity = (text: string): string => text;
const editorTheme: EditorTheme = {
    borderColor: identity,
    selectList: {
        selectedPrefix: identity,
        selectedText: identity,
        description: identity,
        scrollInfo: identity,
        noMatch: identity,
    },
};

function ghostCommand() {
    return normalizeRegisteredCommand({
        name: "deploy",
        description: "Deploy an application",
        args: {},
        ghostText: ({ ctx, commandName, subcommand }) =>
            `${commandName}:${subcommand ?? "root"}:${ctx.cwd}`,
        run() {},
        subcommands: {
            service: {
                description: "Deploy a service",
                aliases: ["svc"],
                ghostText: ({ ctx, subcommand }) => `${subcommand}:${ctx.cwd}`,
                args: {},
                run() {},
            },
            website: {
                description: "Deploy the website",
                ghostText: "deploy the current website",
                args: {},
                run() {},
            },
            unhinted: {
                description: "No ghost text",
                args: {},
                run() {},
            },
        },
    });
}

describe("inline ghost text resolution", () => {
    it("resolves root, subcommand, and alias hints independently", () => {
        const registry = createTypedCommandRegistry();
        registry.register(ghostCommand());
        const ctx = createTestExtensionContext({ cwd: "/workspace" });
        assert.equal(resolveGhostText("/deploy", registry, ctx)?.text, "deploy:root:/workspace");
        assert.deepEqual(resolveGhostText("/deploy service", registry, ctx), {
            text: "service:/workspace",
            command: registry.get("deploy")?.subcommands?.service,
            subcommand: "service",
        });
        assert.equal(resolveGhostText("/deploy svc", registry, ctx)?.text, "service:/workspace");
        assert.equal(resolveGhostText("/deploy ", registry, ctx)?.text, "deploy:root:/workspace");
        assert.equal(resolveGhostText("/deploy  ", registry, ctx), undefined);
        assert.equal(
            resolveGhostText("/deploy service ", registry, ctx)?.text,
            "service:/workspace",
        );
        assert.equal(resolveGhostText("/deploy service  ", registry, ctx), undefined);
        assert.equal(resolveGhostText("/deploy svc\t", registry, ctx)?.text, "service:/workspace");
        assert.equal(
            resolveGhostText("/deploy website", registry, ctx)?.text,
            "deploy the current website",
        );
        assert.equal(resolveGhostText("/deploy unhinted", registry, ctx), undefined);
    });

    it("hides hints outside exact single-line invocation boundaries", () => {
        const registry = createTypedCommandRegistry();
        registry.register(ghostCommand());
        const ctx = createTestExtensionContext();

        for (const text of [
            "/deplo",
            "/deploy s",
            "/deploy service api",
            "/deploy\n",
            "/deploy\nmore",
            "/deploy\r",
            "deploy",
        ]) {
            assert.equal(resolveGhostText(text, registry, ctx), undefined, text);
        }
    });

    it("contains failing, empty, and control-character resolver output", () => {
        const registry = createTypedCommandRegistry();
        registry.register(
            normalizeRegisteredCommand({
                name: "empty-hint",
                description: "Empty",
                args: {},
                ghostText: () => " \n\t ",
                run() {},
            }),
        );
        registry.register(
            normalizeRegisteredCommand({
                name: "failed-hint",
                description: "Failed",
                args: {},
                ghostText: () => {
                    throw new TypeError("resolver defect");
                },
                run() {},
            }),
        );
        registry.register(
            normalizeRegisteredCommand({
                name: "single-line-hint",
                description: "Single line",
                args: {},
                ghostText: "first\nsecond",
                run() {},
            }),
        );
        const ctx = createTestExtensionContext();
        assert.equal(resolveGhostText("/empty-hint", registry, ctx), undefined);
        assert.equal(resolveGhostText("/failed-hint", registry, ctx), undefined);
        assert.equal(resolveGhostText("/single-line-hint", registry, ctx)?.text, "first second");
    });

    it("resolves declarative typed-skill ghost text", () => {
        const registry = createTypedCommandRegistry();
        registry.register(
            typedSkillCommandFromMetadata({
                name: "lint",
                description: "Lint files",
                filePath: "/skills/lint/SKILL.md",
                baseDir: "/skills/lint",
                body: "Lint {args.path}.",
                args: {},
                ghostText: "choose files to lint",
            }),
        );
        const ctx = createTestExtensionContext();
        assert.equal(resolveGhostText("/skill:lint", registry, ctx)?.text, "choose files to lint");
        assert.equal(resolveGhostText("/skill:lint ", registry, ctx)?.text, "choose files to lint");
        assert.equal(resolveGhostText("/skill:lint  ", registry, ctx), undefined);
    });
});

describe("inline ghost text editor", () => {
    it("renders dimmed Unicode text inline without changing or submitting it", () => {
        const editor = new CustomEditor(createTestTui(), editorTheme, createTestKeybindings());
        let styleCode = "2";
        const wrapped = withGhostText(
            editor,
            () => "ghost 🛰️",
            (text) => `\x1b[${styleCode}m${text}\x1b[22m`,
        );
        requireFocusableComponent(wrapped).focused = true;
        wrapped.setText("/deploy");
        const lines = wrapped.render(24);
        assert.match(lines.join("\n"), /ghost 🛰️/);
        assert.equal(
            lines.every((line) => visibleWidth(line) <= 24),
            true,
        );
        assert.equal(wrapped.getText(), "/deploy");
        assert.equal(lines.join("\n").includes("\x1b[2mghost"), true);
        const actionHandlers: unknown = Reflect.get(wrapped, "actionHandlers");
        assert.equal(actionHandlers, editor.actionHandlers);
        styleCode = "90";
        wrapped.invalidate();
        assert.equal(wrapped.render(24).join("\n").includes("\x1b[90mghost"), true);
        let submitted: string | undefined;
        wrapped.onSubmit = (text) => {
            submitted = text;
        };
        wrapped.handleInput("\r");
        assert.equal(submitted, "/deploy");
    });

    it("hides at a non-terminal cursor and after additional input", () => {
        const editor = new CustomEditor(createTestTui(), editorTheme, createTestKeybindings());
        const getGhostText = (): string | undefined => {
            if (/^\/deploy\s*$/.test(editor.getText())) {
                return "ghost text";
            }

            return undefined;
        };

        const wrapped = withGhostText(editor, getGhostText, identity);
        requireFocusableComponent(wrapped).focused = true;
        wrapped.setText("/deploy");
        wrapped.handleInput("\x1b[D");
        assert.doesNotMatch(wrapped.render(40).join("\n"), /ghost text/);
        wrapped.setText("/deploy");
        wrapped.handleInput(" ");
        assert.equal(wrapped.getText(), "/deploy ");
        assert.match(wrapped.render(40).join("\n"), /ghost text/);
        wrapped.handleInput("a");
        assert.equal(wrapped.getText(), "/deploy a");
        assert.doesNotMatch(wrapped.render(40).join("\n"), /ghost text/);
    });

    it("truncates inserted ghost text and leaves incompatible editors untouched", () => {
        const rendered = renderGhostTextOnEditorLines(
            ["/deploy\u001b_pi:c\u0007\x1b[7m \x1b[0m       "],
            12,
            "very long ghost text",
            identity,
        );
        assert.equal(
            rendered.every((line) => visibleWidth(line) <= 12),
            true,
        );

        const incompatible: EditorComponent = {
            render: () => ["custom"],
            invalidate() {},
            handleInput() {},
            getText: () => "",
            setText() {},
        };
        assert.equal(
            withGhostText(incompatible, () => "ghost", identity),
            incompatible,
        );
    });

    it("delegates optional editor capabilities through the decorator", () => {
        const records: string[] = [];
        let value = "/deploy";

        const provider: AutocompleteProvider = {
            async getSuggestions() {
                return null;
            },
            applyCompletion(lines, cursorLine, cursorCol) {
                return { lines, cursorLine, cursorCol };
            },
        };
        const base: EditorComponent & {
            focused: boolean;
            getCursor(): { line: number; col: number };
        } = {
            focused: true,
            render: () => [`/deploy\u001b_pi:c\u0007\x1b[7m \x1b[0m`],
            invalidate() {
                records.push("invalidate");
            },
            handleInput(data) {
                records.push(`input:${data}`);
            },
            getText: () => value,
            getCursor: () => ({ line: 0, col: value.length }),
            setText(text) {
                value = text;
            },
            addToHistory(text) {
                records.push(`history:${text}`);
            },
            insertTextAtCursor(text) {
                value += text;
            },
            getExpandedText: () => `expanded:${value}`,
            setAutocompleteProvider(received) {
                assert.equal(received, provider);
                records.push("autocomplete");
            },
            setPaddingX(padding) {
                records.push(`padding:${padding}`);
            },
            setAutocompleteMaxVisible(maxVisible) {
                records.push(`max:${maxVisible}`);
            },
        };
        const wrapped = withGhostText(base, () => "ghost", identity);

        wrapped.addToHistory?.("/old");
        wrapped.insertTextAtCursor?.(" service");
        wrapped.setAutocompleteProvider?.(provider);
        wrapped.setPaddingX?.(2);
        wrapped.setAutocompleteMaxVisible?.(5);
        wrapped.handleInput("key");
        wrapped.invalidate();
        assert.equal(wrapped.getText(), "/deploy service");
        assert.equal(wrapped.getExpandedText?.(), "expanded:/deploy service");
        assert.deepEqual(records, [
            "history:/old",
            "autocomplete",
            "padding:2",
            "max:5",
            "input:key",
            "invalidate",
        ]);
    });

    it("preserves and restores an existing editor factory for the session lifecycle", async () => {
        type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;

        const registry = createTypedCommandRegistry();
        registry.register(ghostCommand());
        const pi = createTestExtensionApi();
        const previous: EditorFactory = (tui, theme, keybindings) =>
            new CustomEditor(tui, theme, keybindings);

        let current: EditorFactory | undefined = previous;
        let activeComponent: EditorComponent | undefined;
        let editorText = "/deploy";
        const widgetContent: unknown[] = [];
        const ctx = createTestExtensionContext({
            cwd: "/workspace",
            ui: {
                getEditorComponent: () => current,
                getEditorText: () => editorText,
                setEditorComponent: (factory) => {
                    current = factory;
                    activeComponent = factory?.(
                        createTestTui(),
                        editorTheme,
                        createTestKeybindings(),
                    );
                },
                setEditorText: (text) => {
                    editorText = text;
                },
                setWidget: (_key, content) => {
                    widgetContent.push(content);
                },
            },
        });
        const session = new TypedCommandUxSession(pi, {}, registry);

        await session.start(ctx);
        assert.notEqual(current, previous);
        const component = activeComponent;
        if (component === undefined) {
            assert.fail("expected the installed editor factory to return a component");
        }

        requireFocusableComponent(component).focused = true;
        component.setText(editorText);
        assert.match(component.render(50).join("\n"), /deploy:root:\/workspace/);
        component.setText("/deploy ");
        assert.match(component.render(50).join("\n"), /deploy:root:\/workspace/);
        component.setText("/deploy  ");
        assert.doesNotMatch(component.render(50).join("\n"), /deploy:root:\/workspace/);
        assert.equal(widgetContent.length, 1);
        await session.stop();
        assert.equal(current, previous);
    });

    it("does not replace the editor until ghost text is configured", async () => {
        type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;

        const registry = createTypedCommandRegistry();
        registry.register(
            normalizeRegisteredCommand({
                name: "ordinary",
                description: "No ghost text",
                args: {},
                run() {},
            }),
        );
        const previous: EditorFactory = (tui, theme, keybindings) =>
            new CustomEditor(tui, theme, keybindings);

        let current: EditorFactory | undefined = previous;
        let replacements = 0;
        const ctx = createTestExtensionContext({
            ui: {
                getEditorComponent: () => current,
                setEditorComponent: (factory) => {
                    replacements += 1;
                    current = factory;
                    factory?.(createTestTui(), editorTheme, createTestKeybindings());
                },
            },
        });
        const session = new TypedCommandUxSession(createTestExtensionApi(), {}, registry);

        await session.start(ctx);
        assert.equal(current, previous);
        assert.equal(replacements, 0);

        const hinted = normalizeRegisteredCommand({
            name: "branch-only-hint",
            description: "Branch-only ghost text",
            args: {},
            subcommands: {
                inspect: {
                    description: "Inspect",
                    ghostText: "choose a target",
                    args: {},
                    run() {},
                },
            },
        });
        registry.register(hinted);
        assert.notEqual(current, previous);
        assert.equal(replacements, 1);
        registry.unregister(hinted);
        assert.equal(current, previous);
        assert.equal(replacements, 2);
        await session.stop();
        assert.equal(replacements, 2);
    });

    it("restarts the session editor integration without stacking decorators", async () => {
        type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;

        const registry = createTypedCommandRegistry();
        registry.register(ghostCommand());
        const previous: EditorFactory = (tui, theme, keybindings) =>
            new CustomEditor(tui, theme, keybindings);

        let current: EditorFactory | undefined = previous;
        let replacements = 0;
        const ctx = createTestExtensionContext({
            ui: {
                getEditorComponent: () => current,
                setEditorComponent: (factory) => {
                    replacements += 1;
                    current = factory;
                    factory?.(createTestTui(), editorTheme, createTestKeybindings());
                },
            },
        });
        const session = new TypedCommandUxSession(createTestExtensionApi(), {}, registry);

        await session.start(ctx);
        const first = current;
        assert.notEqual(first, previous);
        await session.start(ctx);
        assert.notEqual(current, previous);
        assert.notEqual(current, first);
        assert.equal(replacements, 3);
        await session.stop();
        assert.equal(current, previous);
        assert.equal(replacements, 4);
    });

    it("keeps the live helper when an existing editor is incompatible", async () => {
        type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;

        const registry = createTypedCommandRegistry();
        registry.register(ghostCommand());
        const incompatible: EditorComponent = {
            render: () => ["custom"],
            invalidate() {},
            handleInput() {},
            getText: () => "/deploy",
            setText() {},
        };
        const previous: EditorFactory = () => incompatible;
        let current: EditorFactory | undefined = previous;
        const widgetContent: unknown[] = [];
        const ctx = createTestExtensionContext({
            ui: {
                getEditorComponent: () => current,
                getEditorText: () => "/deploy",
                setEditorComponent: (factory) => {
                    current = factory;
                    factory?.(createTestTui(), editorTheme, createTestKeybindings());
                },
                setWidget: (_key, content) => {
                    widgetContent.push(content);
                },
            },
        });
        const session = new TypedCommandUxSession(createTestExtensionApi(), {}, registry);

        await session.start(ctx);
        assert.equal(widgetContent.length, 1);
        await session.stop();
        assert.equal(current, previous);
    });

    it("does not overwrite an editor installed later by another extension", async () => {
        type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;

        const registry = createTypedCommandRegistry();
        registry.register(ghostCommand());
        const previous: EditorFactory = (tui, theme, keybindings) =>
            new CustomEditor(tui, theme, keybindings);

        const later: EditorFactory = (tui, theme, keybindings) =>
            new CustomEditor(tui, theme, keybindings);

        let current: EditorFactory | undefined = previous;
        const ctx = createTestExtensionContext({
            ui: {
                getEditorComponent: () => current,
                setEditorComponent: (factory) => {
                    current = factory;
                    factory?.(createTestTui(), editorTheme, createTestKeybindings());
                },
            },
        });
        const session = new TypedCommandUxSession(createTestExtensionApi(), {}, registry);

        await session.start(ctx);
        assert.notEqual(current, previous);
        current = later;
        await session.stop();
        assert.equal(current, later);
    });
});
