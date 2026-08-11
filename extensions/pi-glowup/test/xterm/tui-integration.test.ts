import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import {
    TuiAltScreen,
    TuiMainScreen,
    visibleWidth,
    type Component,
    type TUI,
} from "@earendil-works/pi-tui";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGlowupGlobalConfigPath } from "../../src/config/config.ts";
import { buildPierreDiffPayload } from "../../src/diffs/diff.ts";
import { configureAutocompleteCleanupPatch } from "../../src/patches/autocomplete-cleanup.ts";
import { GlowupExtensionHarness } from "../support/extension-harness.ts";
import { applyPatchOwnerToolDefinition } from "../support/apply-patch-owner-fixture.ts";
import { VirtualTerminal } from "../support/virtual-terminal.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const originalAgentDir = process.env[AGENT_DIR_ENV];

const obsoletePatch = `*** Begin Patch
*** Add File: src/obsolete.ts
+export const obsolete = 2;
+export const staleTailOne = true;
+export const staleTailTwo = true;
*** End Patch`;

const currentPatch = `*** Begin Patch
*** Add File: src/current.ts
+export const currentValue = 2;
*** End Patch`;

class LinesComponent implements Component {
    constructor(public lines: string[]) {}

    render(_width: number): string[] {
        return [...this.lines];
    }

    invalidate(): void {}
}

type CleanupEditor = {
    readonly tui: TUI;
    readonly content: LinesComponent;
    autocompletePrefix: string;
    active: boolean;
    isShowingAutocomplete(): boolean;
};

type CleanupPrototype = {
    clearAutocompleteUi(this: CleanupEditor): void;
};

function countOccurrences(text: string, search: string): number {
    return text.split(search).length - 1;
}

function rowContaining(terminal: VirtualTerminal, text: string) {
    const row = terminal.interpretedRows().find((candidate) => candidate.text.includes(text));
    if (row === undefined)
        throw new Error(`missing terminal row containing ${JSON.stringify(text)}`);
    return row;
}

const tuiVariants = [
    {
        mode: "regular",
        createTui: (terminal: VirtualTerminal): TUI => new TuiMainScreen(terminal),
    },
    {
        mode: "fullscreen",
        createTui: (terminal: VirtualTerminal): TUI => new TuiAltScreen(terminal),
    },
] as const;

describe.each(tuiVariants)("Pi $mode TUI through headless xterm", ({ mode, createTui }) => {
    let root: string;
    let cwd: string;
    let extension: GlowupExtensionHarness;
    let terminal: VirtualTerminal | undefined;
    let tui: TUI | undefined;

    beforeEach(async () => {
        root = mkdtempSync(join(tmpdir(), "pi-glowup-xterm-"));
        cwd = join(root, "workspace");
        const agentDir = join(root, "agent");
        mkdirSync(cwd, { recursive: true });
        mkdirSync(join(agentDir, "extension-settings"), { recursive: true });
        process.env[AGENT_DIR_ENV] = agentDir;
        writeFileSync(
            getGlowupGlobalConfigPath(agentDir),
            JSON.stringify({
                toolLabels: { mode: "lifecycle" },
                appearance: {
                    diffBackgroundStyle: "two-tone",
                    addedRowBackground: "#16351E",
                    deletedRowBackground: "#3B1E1C",
                    addedContentBackground: "#0B441F",
                    deletedContentBackground: "#5C2321",
                },
            }),
        );
        initTheme("dark");
        extension = new GlowupExtensionHarness();
        await extension.install(cwd);
    });

    afterEach(async () => {
        tui?.stop();
        await terminal?.settle(0);
        terminal?.dispose();
        await extension.shutdown();
        rmSync(root, { recursive: true, force: true });
        if (originalAgentDir === undefined) {
            delete process.env[AGENT_DIR_ENV];
        } else {
            process.env[AGENT_DIR_ENV] = originalAgentDir;
        }
    });

    async function start(
        components: readonly Component[],
        columns = 100,
        rows = 30,
    ): Promise<{ readonly terminal: VirtualTerminal; readonly tui: TUI }> {
        terminal = new VirtualTerminal(columns, rows);
        tui = createTui(terminal);
        tui.setClearOnShrink(true);
        for (const component of components) tui.addChild(component);
        tui.start();
        await terminal.settle();
        return { terminal, tui };
    }

    it("interprets apply_patch streaming, shrinking, rewriting, and completion without stale cells", async () => {
        const pendingTerminal = new VirtualTerminal(100, 28);
        const activeTui = createTui(pendingTerminal);
        activeTui.setClearOnShrink(true);
        const tool = new ToolExecutionComponent(
            "apply_patch",
            "call-xterm-stream",
            {},
            undefined,
            applyPatchOwnerToolDefinition,
            activeTui,
            cwd,
        );
        activeTui.addChild(tool);
        terminal = pendingTerminal;
        tui = activeTui;
        activeTui.start();
        await pendingTerminal.settle();

        expect(pendingTerminal.screenText()).toContain("Patching");
        expect(pendingTerminal.screenText()).not.toContain("undefined");

        tool.updateArgs({ patch: obsoletePatch });
        activeTui.requestRender();
        await pendingTerminal.settle();
        expect(pendingTerminal.screenText()).toContain("Patching src/obsolete.ts");
        expect(pendingTerminal.screenText()).toContain("staleTailTwo");

        const shrunkPatch = obsoletePatch.replace(
            "+export const staleTailOne = true;\n+export const staleTailTwo = true;\n",
            "",
        );
        tool.updateArgs({ patch: shrunkPatch });
        activeTui.requestRender();
        await pendingTerminal.settle();
        expect(pendingTerminal.screenText()).not.toContain("staleTailOne");
        expect(pendingTerminal.screenText()).not.toContain("staleTailTwo");

        tool.updateArgs({ patch: currentPatch });
        activeTui.requestRender();
        await pendingTerminal.settle();
        expect(pendingTerminal.screenText()).toContain("Patching src/current.ts");
        expect(pendingTerminal.screenText()).toContain("currentValue");
        expect(pendingTerminal.screenText()).not.toContain("src/obsolete.ts");
        expect(pendingTerminal.screenText()).not.toContain("obsolete = 2");

        tool.setArgsComplete();
        tool.updateResult({
            content: [{ type: "text", text: "Done!" }],
            details: {
                inputPatch: currentPatch,
                patch: "--- /dev/null\n+++ b/src/current.ts\n@@ -0,0 +1 @@\n+export const currentValue = 2;\n",
                lineSummary: {
                    files: [
                        {
                            action: "A",
                            path: "src/current.ts",
                            addedLines: 1,
                            removedLines: 0,
                        },
                    ],
                },
            },
            isError: false,
        });
        activeTui.requestRender();
        await pendingTerminal.settle();
        const completed = pendingTerminal.screenText();
        expect(completed).toContain("Patched src/current.ts (+1)");
        expect(countOccurrences(completed, "Patched src/current.ts")).toBe(1);
        expect(completed).not.toContain("Done!");
        expect(completed).not.toContain("src/obsolete.ts");
        expect(pendingTerminal.rawWrites().join("")).toContain("\u001b[?2026h");
    });

    it("neutralizes tool-supplied terminal controls before they reach the PTY", async () => {
        const pendingTerminal = new VirtualTerminal(100, 20);
        const activeTui = createTui(pendingTerminal);
        const tool = new ToolExecutionComponent(
            "unknown_tool",
            "call-xterm-controls",
            { prompt: "before\u001b[2Jafter\u001b]2;owned\u0007\tend" },
            undefined,
            undefined,
            activeTui,
            cwd,
        );
        tool.setArgsComplete();
        activeTui.addChild(new LinesComponent(["BEFORE_CONTROL_SENTINEL"]));
        activeTui.addChild(tool);
        activeTui.addChild(new LinesComponent(["AFTER_CONTROL_SENTINEL"]));
        terminal = pendingTerminal;
        tui = activeTui;
        activeTui.start();
        await pendingTerminal.settle();

        const screen = pendingTerminal.screenText();
        const rawWrites = pendingTerminal.rawWrites().join("");
        expect(screen).toContain("BEFORE_CONTROL_SENTINEL");
        expect(screen).toContain("AFTER_CONTROL_SENTINEL");
        expect(screen).toContain("before␛[2Jafter␛]2;owned␇ end");
        expect(rawWrites).not.toContain("\u001b]2;owned");
        expect(rawWrites).not.toContain("owned\u0007");
        expect(rawWrites).not.toContain("\t");
    });

    it("removes and restores the Pierre split divider across wide-narrow-wide redraws", async () => {
        const pendingTerminal = new VirtualTerminal(180, 30);
        const activeTui = createTui(pendingTerminal);
        const payload = buildPierreDiffPayload({
            path: "src/example.ts",
            oldContent: "export const leftValue = 1;\n",
            newContent: "export const rightValue = 2;\n",
            oldSizeBytes: 28,
            newSizeBytes: 29,
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") throw new Error("expected renderable Pierre payload");
        const tool = new ToolExecutionComponent(
            "edit",
            "call-xterm-resize",
            {
                path: "src/example.ts",
                oldText: "export const leftValue = 1;",
                newText: "export const rightValue = 2;",
            },
            undefined,
            undefined,
            activeTui,
            cwd,
        );
        tool.setExpanded(true);
        tool.setArgsComplete();
        tool.updateResult({
            content: [],
            details: { pierreDiff: payload },
            isError: false,
        });
        activeTui.addChild(new LinesComponent(["BEFORE_SENTINEL"]));
        activeTui.addChild(tool);
        activeTui.addChild(new LinesComponent(["AFTER_SENTINEL"]));
        terminal = pendingTerminal;
        tui = activeTui;
        activeTui.start();
        await pendingTerminal.settle();

        const firstWide = pendingTerminal.screenText();
        expect(firstWide).toContain(" │ ");
        expect(countOccurrences(firstWide, "BEFORE_SENTINEL")).toBe(1);
        expect(countOccurrences(firstWide, "AFTER_SENTINEL")).toBe(1);

        pendingTerminal.resize(70, 30);
        await pendingTerminal.settle();
        expect(pendingTerminal.screenText()).not.toContain(" │ ");
        expect(pendingTerminal.interpretedRows().some((row) => row.isWrapped)).toBe(false);

        pendingTerminal.resize(180, 30);
        await pendingTerminal.settle();
        expect(pendingTerminal.screenText()).toBe(firstWide);
        if (mode === "regular") {
            expect(pendingTerminal.rawWrites().join("")).toContain("\u001b[2J\u001b[H\u001b[3J");
        } else {
            expect(pendingTerminal.rawWrites().join("")).toContain("\u001b[?1049h");
        }
    });

    it("renders completed apply_patch details side-by-side and preserves every row", async () => {
        const pendingTerminal = new VirtualTerminal(180, 30);
        const activeTui = createTui(pendingTerminal);
        const patch = `*** Begin Patch
*** Update File: src/example.ts
@@
 alpha
-old
+new
 omega
*** End Patch`;
        const tool = new ToolExecutionComponent(
            "apply_patch",
            "call-xterm-apply-split",
            { patch },
            undefined,
            applyPatchOwnerToolDefinition,
            activeTui,
            cwd,
        );
        tool.setArgsComplete();
        tool.updateResult({
            content: [],
            details: {
                diff: "src/example.ts\n  1 alpha\n- 2 old\n+ 2 new\n  3 omega\n",
                patch: `--- src/example.ts
+++ src/example.ts
@@ -1,3 +1,3 @@
 alpha
-old
+new
 omega
`,
                lineSummary: {
                    files: [
                        {
                            action: "M",
                            path: "src/example.ts",
                            addedLines: 1,
                            removedLines: 1,
                        },
                    ],
                },
            },
            isError: false,
        });
        activeTui.addChild(tool);
        terminal = pendingTerminal;
        tui = activeTui;
        activeTui.start();
        await pendingTerminal.settle();

        const wide = pendingTerminal.screenText();
        expect(wide).toContain("Patched src/example.ts (+1 -1)");
        expect(wide).toContain("alpha");
        expect(wide).toContain("old");
        expect(wide).toContain("new");
        expect(wide).toContain("omega");
        expect(wide).toContain(" │ ");
        expect(wide).not.toContain("to expand");

        pendingTerminal.resize(80, 30);
        await pendingTerminal.settle();
        expect(pendingTerminal.screenText()).not.toContain(" │ ");

        pendingTerminal.resize(180, 30);
        await pendingTerminal.settle();
        expect(pendingTerminal.screenText()).toBe(wide);
    });

    it("keeps every available row from compatible edit result previews", async () => {
        const pendingTerminal = new VirtualTerminal(100, 30);
        const activeTui = createTui(pendingTerminal);
        const tool = new ToolExecutionComponent(
            "edit",
            "call-xterm-compatible-edit",
            { input: "*** Begin Patch\n*** Update File: example.ts#TAG\n*** End Patch" },
            undefined,
            undefined,
            activeTui,
            cwd,
        );
        const preview = Array.from(
            { length: 12 },
            (_value, index) => `${index + 1}:export const value${index + 1} = ${index + 1};`,
        ).join("\n");
        tool.setArgsComplete();
        tool.updateResult({
            content: [{ type: "text", text: `[example.ts#NEXT] (+12)\n${preview}` }],
            details: {
                files: [
                    {
                        path: "example.ts",
                        tag: "NEXT",
                        preview,
                        addedLines: 12,
                        removedLines: 0,
                        removed: false,
                        warnings: [],
                    },
                ],
            },
            isError: false,
        });
        activeTui.addChild(tool);
        terminal = pendingTerminal;
        tui = activeTui;
        activeTui.start();
        await pendingTerminal.settle();

        const rendered = pendingTerminal.screenText();
        expect(rendered).toContain("value1 = 1");
        expect(rendered).toContain("value6 = 6");
        expect(rendered).toContain("value12 = 12");
        expect(rendered).not.toContain("more lines");
    });

    it("expands and collapses without duplicating or overwriting adjacent transcript blocks", async () => {
        const pendingTerminal = new VirtualTerminal(110, 32);
        const activeTui = createTui(pendingTerminal);
        const patch = `*** Begin Patch
*** Add File: src/expanded.ts
+export const line1 = 1;
+export const line2 = 2;
+export const line3 = 3;
+export const line4 = 4;
+export const line5 = 5;
+export const line6 = 6;
+export const line7 = 7;
+export const line8 = 8;
+export const line9 = 9;
*** End Patch`;
        const tool = new ToolExecutionComponent(
            "apply_patch",
            "call-xterm-expand",
            { patch },
            undefined,
            applyPatchOwnerToolDefinition,
            activeTui,
            cwd,
        );
        tool.setArgsComplete();
        tool.updateResult({
            content: [],
            details: {
                inputPatch: patch,
                patch: `--- /dev/null
+++ b/src/expanded.ts
@@ -0,0 +1,9 @@
+export const line1 = 1;
+export const line2 = 2;
+export const line3 = 3;
+export const line4 = 4;
+export const line5 = 5;
+export const line6 = 6;
+export const line7 = 7;
+export const line8 = 8;
+export const line9 = 9;
`,
                lineSummary: {
                    files: [
                        {
                            action: "A",
                            path: "src/expanded.ts",
                            addedLines: 9,
                            removedLines: 0,
                        },
                    ],
                },
            },
            isError: false,
        });
        activeTui.addChild(new LinesComponent(["BEFORE_TRANSCRIPT"]));
        activeTui.addChild(tool);
        activeTui.addChild(new LinesComponent(["AFTER_TRANSCRIPT"]));
        terminal = pendingTerminal;
        tui = activeTui;
        activeTui.start();
        await pendingTerminal.settle();
        const collapsed = pendingTerminal.screenText();
        expect(collapsed).toContain("line9");
        expect(collapsed).not.toContain("to expand");

        tool.setExpanded(true);
        activeTui.requestRender();
        await pendingTerminal.settle();
        const expanded = pendingTerminal.screenText();
        expect(expanded).toContain("line9");
        expect(countOccurrences(expanded, "Patched src/expanded.ts")).toBe(1);
        expect(countOccurrences(expanded, "BEFORE_TRANSCRIPT")).toBe(1);
        expect(countOccurrences(expanded, "AFTER_TRANSCRIPT")).toBe(1);

        tool.setExpanded(false);
        activeTui.requestRender();
        await pendingTerminal.settle();
        expect(pendingTerminal.screenText()).toBe(collapsed);
    });

    it("keeps full-row diff backgrounds and syntax colors scoped away from context and a sentinel", async () => {
        const pendingTerminal = new VirtualTerminal(90, 28);
        const activeTui = createTui(pendingTerminal);
        const oldContent =
            "const removedOnly = true;\nconst unchangedA = true;\nconst unchangedB = true;\nconst previousValue = 1;\n";
        const newContent =
            "const unchangedA = true;\n\nconst unchangedB = true;\nexport const nextValue = 2;\n\treturn tabIndentedValue;\n";
        const payload = buildPierreDiffPayload({
            path: "src/colors.ts",
            oldContent,
            newContent,
            oldSizeBytes: Buffer.byteLength(oldContent),
            newSizeBytes: Buffer.byteLength(newContent),
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") throw new Error("expected renderable Pierre payload");
        const patch = `*** Begin Patch
*** Update File: src/colors.ts
@@
-const removedOnly = true;
 const unchangedA = true;
+
 const unchangedB = true;
-const previousValue = 1;
+export const nextValue = 2;
+\treturn tabIndentedValue;
*** End Patch`;
        const tool = new ToolExecutionComponent(
            "apply_patch",
            "call-xterm-style",
            { patch },
            undefined,
            applyPatchOwnerToolDefinition,
            activeTui,
            cwd,
        );
        tool.setArgsComplete();
        tool.updateResult({
            content: [],
            details: {
                pierreDiff: payload,
                inputPatch: patch,
                patch: `--- a/src/colors.ts
+++ b/src/colors.ts
@@ -1,4 +1,5 @@
-const removedOnly = true;
 const unchangedA = true;
+
 const unchangedB = true;
-const previousValue = 1;
+export const nextValue = 2;
+\treturn tabIndentedValue;
`,
                lineSummary: {
                    files: [
                        {
                            action: "M",
                            path: "src/colors.ts",
                            addedLines: 3,
                            removedLines: 2,
                        },
                    ],
                },
            },
            isError: false,
        });
        activeTui.addChild(tool);
        activeTui.addChild(new LinesComponent(["PLAIN_SENTINEL"]));
        terminal = pendingTerminal;
        tui = activeTui;
        activeTui.start();
        await pendingTerminal.settle();

        const standaloneDeletion = rowContaining(pendingTerminal, "removedOnly");
        const blankAddition = pendingTerminal
            .interpretedRows()
            .find((candidate) => candidate.text.trimEnd().endsWith("+"));
        if (blankAddition === undefined) throw new Error("missing blank addition row");
        const deletion = rowContaining(pendingTerminal, "previousValue");
        const addition = rowContaining(pendingTerminal, "nextValue");
        const tabAddition = rowContaining(pendingTerminal, "tabIndentedValue");
        const context = rowContaining(pendingTerminal, "unchanged");
        const sentinel = rowContaining(pendingTerminal, "PLAIN_SENTINEL");
        expect(standaloneDeletion.cells).toHaveLength(90);
        expect(blankAddition.cells).toHaveLength(90);
        expect(deletion.cells).toHaveLength(90);
        expect(addition.cells).toHaveLength(90);
        expect(tabAddition.cells).toHaveLength(90);
        expect(standaloneDeletion.cells.every((cell) => !cell.isBackgroundDefault)).toBe(true);
        expect(blankAddition.cells.every((cell) => !cell.isBackgroundDefault)).toBe(true);
        expect(deletion.cells.every((cell) => !cell.isBackgroundDefault)).toBe(true);
        expect(addition.cells.every((cell) => !cell.isBackgroundDefault)).toBe(true);
        expect(tabAddition.cells.every((cell) => !cell.isBackgroundDefault)).toBe(true);
        expect(new Set(standaloneDeletion.cells.map((cell) => cell.background)).size).toBe(1);
        expect(new Set(blankAddition.cells.map((cell) => cell.background)).size).toBe(1);
        expect(new Set(tabAddition.cells.map((cell) => cell.background)).size).toBe(1);
        expect(new Set(deletion.cells.map((cell) => cell.background)).size).toBeGreaterThan(1);
        expect(new Set(addition.cells.map((cell) => cell.background)).size).toBeGreaterThan(1);
        expect(
            context.cells
                .filter((cell) => cell.chars !== "")
                .every((cell) => cell.isBackgroundDefault),
        ).toBe(true);

        const codeStart = addition.text.indexOf("export const nextValue = 2;");
        expect(codeStart).toBeGreaterThanOrEqual(0);
        const syntaxForegrounds = new Set(
            addition.cells
                .slice(codeStart, codeStart + "export const nextValue = 2;".length)
                .filter((cell) => cell.chars.trim().length > 0)
                .map((cell) => cell.foreground),
        );
        expect(syntaxForegrounds.size).toBeGreaterThan(1);
        expect(sentinel.cells.slice(0, "PLAIN_SENTINEL".length)).toSatisfy(
            (cells: readonly (typeof sentinel.cells)[number][]) =>
                cells.every(
                    (cell) =>
                        cell.isForegroundDefault &&
                        cell.isBackgroundDefault &&
                        !cell.isBold &&
                        !cell.isDim,
                ),
        );
    });

    it("clears stale autocomplete rows by forcing a real Pi full redraw", async () => {
        const content = new LinesComponent([
            "EDITOR_PROMPT",
            "/first stale completion",
            "/second stale completion",
            "/third stale completion",
        ]);
        const running = await start([content], 80, 20);
        expect(running.terminal.screenText()).toContain("third stale completion");
        const writesBeforeCleanup = running.terminal.rawWrites().length;
        const prototype: CleanupPrototype = {
            clearAutocompleteUi(this: CleanupEditor): void {
                this.active = false;
                this.autocompletePrefix = "";
                this.content.lines = ["EDITOR_PROMPT"];
            },
        };
        configureAutocompleteCleanupPatch(true, prototype);
        const editor: CleanupEditor = {
            tui: running.tui,
            content,
            autocompletePrefix: "/thi",
            active: true,
            isShowingAutocomplete() {
                return this.active;
            },
        };

        prototype.clearAutocompleteUi.call(editor);
        await running.terminal.settle();

        expect(running.terminal.screenText().trimEnd()).toBe("EDITOR_PROMPT");
        expect(running.terminal.screenText()).not.toContain("stale completion");
        const cleanupWrites = running.terminal.rawWrites().slice(writesBeforeCleanup).join("");
        if (mode === "regular") {
            expect(cleanupWrites).toContain("\u001b[2J\u001b[H\u001b[3J");
        } else {
            expect(cleanupWrites).toContain("\u001b[1;1H\u001b[2K");
        }
        expect(
            running.terminal.interpretedRows().every((row) => visibleWidth(row.text) <= 80),
        ).toBe(true);
        configureAutocompleteCleanupPatch(false, prototype);
    });
});
