import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import {
    getCapabilities,
    setCapabilities,
    TuiAltScreen,
    TuiMainScreen,
    type Component,
    type TUI,
} from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGlowupGlobalConfigPath } from "../../src/config/config.ts";
import { buildPierreDiffPayload } from "../../src/diffs/diff.ts";
import { configureAutocompleteCleanupPatch } from "../../src/patches/autocomplete-cleanup.ts";
import { GlowupExtensionHarness } from "../support/extension-harness.ts";
import { applyPatchOwnerToolDefinition } from "../support/apply-patch-owner-fixture.ts";
import {
    rgbFromHex,
    type InterpretedCell,
    type InterpretedRow,
    VirtualTerminal,
} from "../support/virtual-terminal.ts";
const originalTerminalCapabilities = getCapabilities();

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

type ExtensionProfile = {
    readonly theme?: "dark" | "light";
    readonly appearance?:
        | "default"
        | {
              readonly diffBackgroundStyle: "solid" | "two-tone";
              readonly addedRowBackground: string;
              readonly deletedRowBackground: string;
              readonly addedContentBackground: string;
              readonly deletedContentBackground: string;
          };
};

const DEFAULT_APPEARANCE: Exclude<ExtensionProfile["appearance"], "default" | undefined> = {
    diffBackgroundStyle: "two-tone",
    addedRowBackground: "#16351E",
    deletedRowBackground: "#3B1E1C",
    addedContentBackground: "#0B441F",
    deletedContentBackground: "#5C2321",
};

const EXTENSION_DEFAULT_APPEARANCE = {
    diffBackgroundStyle: "two-tone",
    addedRowBackground: "#213A2B",
    deletedRowBackground: "#4A221D",
    addedContentBackground: "#0D5728",
    deletedContentBackground: "#762925",
} as const;

const LIGHT_CUSTOM_APPEARANCE = {
    diffBackgroundStyle: "two-tone",
    addedRowBackground: "#E6C84A",
    deletedRowBackground: "#D79AB8",
    addedContentBackground: "#F4A261",
    deletedContentBackground: "#B565D9",
} as const;

type ThemeStyleProfile = {
    readonly name: string;
    readonly theme: "dark" | "light";
    readonly appearance: Exclude<ExtensionProfile["appearance"], undefined>;
    readonly expectedAppearance: Exclude<ExtensionProfile["appearance"], "default" | undefined>;
    readonly expectedAddedForeground: string;
    readonly expectedDeletedForeground: string;
};

const THEME_STYLE_PROFILES: readonly ThemeStyleProfile[] = [
    {
        name: "light theme with resolved extension defaults",
        theme: "light",
        appearance: "default",
        expectedAppearance: EXTENSION_DEFAULT_APPEARANCE,
        expectedAddedForeground: "#588458",
        expectedDeletedForeground: "#AA5555",
    },
    {
        name: "light theme with a custom four-color palette",
        theme: "light",
        appearance: LIGHT_CUSTOM_APPEARANCE,
        expectedAppearance: LIGHT_CUSTOM_APPEARANCE,
        expectedAddedForeground: "#588458",
        expectedDeletedForeground: "#AA5555",
    },
    {
        name: "dark theme with the existing custom four-color palette",
        theme: "dark",
        appearance: DEFAULT_APPEARANCE,
        expectedAppearance: DEFAULT_APPEARANCE,
        expectedAddedForeground: "#B5BD68",
        expectedDeletedForeground: "#CC6666",
    },
];

type CellSpan = {
    readonly start: number;
    readonly end: number;
};

function displayCellText(cell: InterpretedCell): string {
    if (cell.width === 0) return "";
    return cell.chars === "" ? " " : cell.chars;
}

function requireDisplayCellSpan(row: InterpretedRow, text: string): CellSpan {
    for (let start = 0; start < row.cells.length; start += 1) {
        let candidate = "";
        for (let end = start; end < row.cells.length; end += 1) {
            candidate += displayCellText(row.cells[end]!);
            if (candidate === text) return { start, end: end + 1 };
            if (!text.startsWith(candidate)) break;
        }
    }
    throw new Error(
        `expected terminal row ${row.index} to contain display-cell span ${JSON.stringify(text)}; row=${JSON.stringify(row.text)}`,
    );
}

function expectRgbBackgrounds(
    row: InterpretedRow,
    expectedColors: readonly number[],
    columns: number,
): void {
    expect(row.cells).toHaveLength(columns);
    expect(new Set(row.cells.map((cell) => cell.background))).toEqual(new Set(expectedColors));
    expect(row.cells.every((cell) => cell.isBackgroundRgb)).toBe(true);
}

function expectRgbBackgroundSpan(
    row: InterpretedRow,
    span: CellSpan,
    expectedBackground: number,
): void {
    expect(
        row.cells
            .slice(span.start, span.end)
            .every((cell) => cell.isBackgroundRgb && cell.background === expectedBackground),
    ).toBe(true);
}

function expectDefaultBackgroundWithoutDiffAttributes(row: InterpretedRow): void {
    expect(row.cells.every((cell) => cell.isBackgroundDefault)).toBe(true);
    expect(row.cells.every((cell) => !cell.isBold && !cell.isDim)).toBe(true);
}
const DARK_THEME_DIM_FOREGROUND = rgbFromHex("#666666");
const DARK_THEME_ADDED_FOREGROUND = rgbFromHex("#B5BD68");
const DARK_THEME_DELETED_FOREGROUND = rgbFromHex("#CC6666");

const cleanupPrototype: CleanupPrototype = {
    clearAutocompleteUi(this: CleanupEditor): void {
        this.active = false;
        this.autocompletePrefix = "";
        this.content.lines = ["EDITOR_PROMPT"];
    },
};

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
    let agentDir: string;
    let extension: GlowupExtensionHarness | undefined;
    let terminal: VirtualTerminal | undefined;
    let tui: TUI | undefined;

    beforeEach(async () => {
        root = mkdtempSync(join(tmpdir(), "pi-glowup-xterm-"));
        cwd = join(root, "workspace");
        agentDir = join(root, "agent");
        setCapabilities({ ...originalTerminalCapabilities, trueColor: true });
        mkdirSync(cwd, { recursive: true });
        mkdirSync(join(agentDir, "extension-settings"), { recursive: true });
        process.env[AGENT_DIR_ENV] = agentDir;
        await installExtension();
    });

    afterEach(async () => {
        try {
            try {
                tui?.stop();
                await terminal?.settle(0);
            } finally {
                terminal?.dispose();
                terminal = undefined;
                tui = undefined;
                try {
                    await shutdownExtension();
                } finally {
                    configureAutocompleteCleanupPatch(false, cleanupPrototype);
                    try {
                        setCapabilities(originalTerminalCapabilities);
                        initTheme("dark");
                    } finally {
                        rmSync(root, { recursive: true, force: true });
                        if (originalAgentDir === undefined) {
                            delete process.env[AGENT_DIR_ENV];
                        } else {
                            process.env[AGENT_DIR_ENV] = originalAgentDir;
                        }
                    }
                }
            }
        } finally {
            setCapabilities(originalTerminalCapabilities);
        }
    });

    async function shutdownExtension(reason: "quit" | "reload" = "quit"): Promise<void> {
        const installedExtension = extension;
        extension = undefined;
        if (installedExtension !== undefined) await installedExtension.shutdown(reason);
    }

    async function installExtension(profile: ExtensionProfile = {}): Promise<void> {
        await shutdownExtension("reload");
        initTheme(profile.theme ?? "dark");
        const appearance =
            profile.appearance === "default"
                ? {}
                : { appearance: profile.appearance ?? DEFAULT_APPEARANCE };
        writeFileSync(
            getGlowupGlobalConfigPath(agentDir),
            JSON.stringify({ toolLabels: { mode: "lifecycle" }, ...appearance }),
        );
        const installedExtension = new GlowupExtensionHarness();
        extension = installedExtension;
        await installedExtension.install(cwd);
    }

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
        expect(pendingTerminal.countOccurrences("Patched src/current.ts")).toBe(1);
        expect(completed).not.toContain("Done!");
        expect(completed).not.toContain("src/obsolete.ts");
        expect(pendingTerminal.rawWrites().join("")).toContain("\u001b[?2026h");
    });

    it("renders the complete write lifecycle without stale content or styles", async () => {
        const pendingTerminal = new VirtualTerminal(110, 30);
        const activeTui = createTui(pendingTerminal);
        activeTui.setClearOnShrink(true);
        const tool = new ToolExecutionComponent(
            "write",
            "call-xterm-write-lifecycle",
            {},
            undefined,
            undefined,
            activeTui,
            cwd,
        );
        const beforeSentinel = "BEFORE_WRITE_LIFECYCLE";
        const afterSentinel = "AFTER_WRITE_LIFECYCLE";
        activeTui.addChild(new LinesComponent([beforeSentinel]));
        activeTui.addChild(tool);
        activeTui.addChild(new LinesComponent([afterSentinel]));
        terminal = pendingTerminal;
        tui = activeTui;
        activeTui.start();
        await pendingTerminal.settle();

        let screen = pendingTerminal.screenText();
        expect(screen).not.toContain("Writing");
        expect(screen).not.toContain("undefined");
        expect(screen).not.toContain("{}");
        expect(pendingTerminal.countOccurrences(beforeSentinel)).toBe(1);
        expect(pendingTerminal.countOccurrences(afterSentinel)).toBe(1);
        const emptyBeforeSentinelRow = pendingTerminal.requireRowContaining(beforeSentinel);
        const emptyAfterSentinelRow = pendingTerminal.requireRowContaining(afterSentinel);
        expect(emptyAfterSentinelRow.index).toBe(emptyBeforeSentinelRow.index + 1);

        tool.updateArgs({ path: "src/streaming-write.ts" });
        activeTui.requestRender();
        await pendingTerminal.settle();
        screen = pendingTerminal.screenText();
        expect(screen).not.toContain("Writing");
        expect(screen).not.toContain("src/streaming-write.ts");
        expect(pendingTerminal.countOccurrences(beforeSentinel)).toBe(1);
        expect(pendingTerminal.countOccurrences(afterSentinel)).toBe(1);
        const pathOnlyBeforeSentinelRow = pendingTerminal.requireRowContaining(beforeSentinel);
        const pathOnlyAfterSentinelRow = pendingTerminal.requireRowContaining(afterSentinel);
        expect(pathOnlyAfterSentinelRow.index).toBe(pathOnlyBeforeSentinelRow.index + 1);

        const initialContent =
            "export const retainedWrite = 1;\nexport const staleWriteOne = 2;\nexport const staleWriteTwo = 3;\n";
        tool.updateArgs({ path: "src/streaming-write.ts", content: initialContent });
        activeTui.requestRender();
        await pendingTerminal.settle();
        screen = pendingTerminal.screenText();
        expect(screen).toContain("Writing src/streaming-write.ts (+3)");
        expect(screen).toContain("retainedWrite");
        expect(screen).toContain("staleWriteOne");
        expect(screen).toContain("staleWriteTwo");
        pendingTerminal.assertUniqueTranscriptMarkers(
            "Writing src/streaming-write.ts",
            beforeSentinel,
            afterSentinel,
        );
        for (const token of ["retainedWrite", "staleWriteOne", "staleWriteTwo"]) {
            pendingTerminal.assertFullRowBackground(
                pendingTerminal.requireRowContaining(token),
                rgbFromHex(DEFAULT_APPEARANCE.addedRowBackground),
            );
        }
        pendingTerminal.assertNeutralRange(
            pendingTerminal.requireRowContaining(beforeSentinel),
            0,
            pendingTerminal.columns,
        );
        pendingTerminal.assertNeutralRange(
            pendingTerminal.requireRowContaining(afterSentinel),
            0,
            pendingTerminal.columns,
        );
        const initialRow = pendingTerminal.requireRowContaining("retainedWrite");
        const initialCodeColumn = initialRow.text.indexOf("export const retainedWrite");
        expect(initialCodeColumn).toBeGreaterThan(0);
        expect(initialRow.text.slice(0, initialCodeColumn)).toBe("      1 +");
        expect(initialRow.cells[6]?.chars).toBe("1");
        expect(initialRow.cells[6]?.foreground).toBe(DARK_THEME_DIM_FOREGROUND);
        expect(initialRow.cells[8]?.chars).toBe("+");
        expect(initialRow.cells[8]?.foreground).toBe(DARK_THEME_ADDED_FOREGROUND);

        const grownContent = `${initialContent}export const grownWriteFour = 4;
export const grownWriteFive = 5;
export const grownWriteSix = 6;
export const grownWriteSeven = 7;
export const grownWriteEight = 8;
export const grownWriteNine = 9;
export const grownWriteTen = 10;
export const grownWriteEleven = 11;
export const grownWriteTwelve = 12;
`;
        tool.updateArgs({ path: "src/streaming-write.ts", content: grownContent });
        activeTui.requestRender();
        await pendingTerminal.settle();
        screen = pendingTerminal.screenText();
        expect(screen).toContain("Writing src/streaming-write.ts (+12)");
        expect(screen).toContain("grownWriteTwelve");
        pendingTerminal.assertUniqueTranscriptMarkers(
            "Writing src/streaming-write.ts",
            beforeSentinel,
            afterSentinel,
        );
        const grownWriteTwelveRow = pendingTerminal.requireRowContaining("grownWriteTwelve");
        const grownWriteTwelveCodeColumn = grownWriteTwelveRow.text.indexOf(
            "export const grownWriteTwelve",
        );
        expect(grownWriteTwelveRow.text.slice(0, grownWriteTwelveCodeColumn)).toBe("       12 +");
        expect(grownWriteTwelveRow.cells[7]?.chars).toBe("1");
        expect(grownWriteTwelveRow.cells[8]?.chars).toBe("2");
        expect(grownWriteTwelveRow.cells[7]?.foreground).toBe(DARK_THEME_DIM_FOREGROUND);
        expect(grownWriteTwelveRow.cells[8]?.foreground).toBe(DARK_THEME_DIM_FOREGROUND);
        expect(grownWriteTwelveRow.cells[10]?.chars).toBe("+");
        expect(grownWriteTwelveRow.cells[10]?.foreground).toBe(DARK_THEME_ADDED_FOREGROUND);
        pendingTerminal.assertNoWrappedRows();
        pendingTerminal.assertRowsFitWidth();
        const grownAfterSentinelRow = pendingTerminal.requireRowContaining(afterSentinel);

        const shrunkContent =
            "export const retainedWrite = 1;\nexport const replacementWrite = 6;\n";
        tool.updateArgs({ path: "src/streaming-write.ts", content: shrunkContent });
        activeTui.requestRender();
        await pendingTerminal.settle();
        screen = pendingTerminal.screenText();
        expect(screen).toContain("Writing src/streaming-write.ts (+2)");
        expect(screen).toContain("replacementWrite");
        for (const obsoleteToken of [
            "staleWriteOne",
            "staleWriteTwo",
            "grownWriteFour",
            "grownWriteFive",
            "grownWriteSix",
            "grownWriteSeven",
            "grownWriteEight",
            "grownWriteNine",
            "grownWriteTen",
            "grownWriteEleven",
            "grownWriteTwelve",
        ]) {
            expect(screen).not.toContain(obsoleteToken);
        }
        pendingTerminal.assertUniqueTranscriptMarkers(
            "Writing src/streaming-write.ts",
            beforeSentinel,
            afterSentinel,
        );
        for (const token of ["retainedWrite", "replacementWrite"]) {
            pendingTerminal.assertFullRowBackground(
                pendingTerminal.requireRowContaining(token),
                rgbFromHex(DEFAULT_APPEARANCE.addedRowBackground),
            );
        }
        pendingTerminal.assertNeutralRange(
            pendingTerminal.requireRowContaining(beforeSentinel),
            0,
            pendingTerminal.columns,
        );
        const shrunkAfterSentinelRow = pendingTerminal.requireRowContaining(afterSentinel);
        pendingTerminal.assertNeutralRange(shrunkAfterSentinelRow);
        for (const vacatedRow of pendingTerminal.rowRange(
            shrunkAfterSentinelRow.index + 1,
            grownAfterSentinelRow.index + 1,
        )) {
            pendingTerminal.assertNeutralRange(vacatedRow);
        }
        pendingTerminal.assertNoWrappedRows();
        pendingTerminal.assertRowsFitWidth();

        const finalPath = "src/final-write.ts";
        const finalContent =
            "export const finalWriteAlpha = 10;\nexport const finalWriteBeta = 20;\nexport const finalWriteGamma = 30;\n";
        tool.updateArgs({ path: finalPath, content: finalContent });
        activeTui.requestRender();
        await pendingTerminal.settle();
        screen = pendingTerminal.screenText();
        expect(screen).toContain("Writing src/final-write.ts (+3)");
        expect(screen).toContain("finalWriteAlpha");
        expect(screen).toContain("finalWriteGamma");
        for (const obsoleteToken of [
            "src/streaming-write.ts",
            "retainedWrite",
            "staleWriteOne",
            "staleWriteTwo",
            "replacementWrite",
            "grownWriteFour",
            "grownWriteFive",
            "grownWriteSix",
            "grownWriteSeven",
            "grownWriteEight",
            "grownWriteNine",
            "grownWriteTen",
            "grownWriteEleven",
            "grownWriteTwelve",
        ]) {
            expect(screen).not.toContain(obsoleteToken);
        }
        pendingTerminal.assertUniqueTranscriptMarkers(
            "Writing src/final-write.ts",
            beforeSentinel,
            afterSentinel,
        );
        for (const token of ["finalWriteAlpha", "finalWriteBeta", "finalWriteGamma"]) {
            pendingTerminal.assertFullRowBackground(
                pendingTerminal.requireRowContaining(token),
                rgbFromHex(DEFAULT_APPEARANCE.addedRowBackground),
            );
        }
        pendingTerminal.assertNeutralRange(
            pendingTerminal.requireRowContaining(beforeSentinel),
            0,
            pendingTerminal.columns,
        );
        expectDefaultBackgroundWithoutDiffAttributes(
            pendingTerminal.requireRowContaining("Writing src/final-write.ts (+3)"),
        );
        pendingTerminal.assertNeutralRange(pendingTerminal.requireRowContaining(afterSentinel));
        pendingTerminal.assertNoWrappedRows();
        pendingTerminal.assertRowsFitWidth();

        tool.setArgsComplete();
        activeTui.requestRender();
        await pendingTerminal.settle();
        screen = pendingTerminal.screenText();
        expect(screen).toContain("Writing src/final-write.ts (+3)");
        expect(screen).toContain("finalWriteAlpha");
        expect(screen).toContain("finalWriteBeta");
        expect(screen).toContain("finalWriteGamma");
        expect(screen).not.toContain("Wrote src/final-write.ts");
        expect(screen).not.toContain('"path":');
        expect(screen).not.toContain('"content":');
        pendingTerminal.assertUniqueTranscriptMarkers(
            "Writing src/final-write.ts",
            beforeSentinel,
            afterSentinel,
        );
        pendingTerminal.assertNeutralRange(
            pendingTerminal.requireRowContaining(beforeSentinel),
            0,
            pendingTerminal.columns,
        );
        expectDefaultBackgroundWithoutDiffAttributes(
            pendingTerminal.requireRowContaining("Writing src/final-write.ts (+3)"),
        );
        pendingTerminal.assertNeutralRange(pendingTerminal.requireRowContaining(afterSentinel));
        pendingTerminal.assertNoWrappedRows();
        pendingTerminal.assertRowsFitWidth();

        const successText = `Successfully wrote ${finalContent.length} bytes to ${finalPath}`;
        tool.updateResult({
            content: [{ type: "text", text: successText }],
            details: undefined,
            isError: false,
        });
        activeTui.requestRender();
        await pendingTerminal.settle();
        screen = pendingTerminal.screenText();
        expect(screen).toContain("Wrote src/final-write.ts (+3)");
        expect(screen).toContain("finalWriteAlpha");
        expect(screen).toContain("finalWriteBeta");
        expect(screen).toContain("finalWriteGamma");
        expect(screen).not.toContain(successText);
        for (const obsoleteToken of [
            "src/streaming-write.ts",
            "retainedWrite",
            "staleWriteOne",
            "staleWriteTwo",
            "replacementWrite",
            "grownWriteFour",
            "grownWriteFive",
            "grownWriteSix",
            "grownWriteSeven",
            "grownWriteEight",
            "grownWriteNine",
            "grownWriteTen",
            "grownWriteEleven",
            "grownWriteTwelve",
        ]) {
            expect(screen).not.toContain(obsoleteToken);
        }
        pendingTerminal.assertUniqueTranscriptMarkers(
            "Wrote src/final-write.ts",
            beforeSentinel,
            afterSentinel,
        );
        pendingTerminal.assertNeutralRange(
            pendingTerminal.requireRowContaining(beforeSentinel),
            0,
            pendingTerminal.columns,
        );
        for (const token of ["finalWriteAlpha", "finalWriteBeta", "finalWriteGamma"]) {
            pendingTerminal.assertFullRowBackground(
                pendingTerminal.requireRowContaining(token),
                rgbFromHex(DEFAULT_APPEARANCE.addedRowBackground),
            );
        }
        const completedHeaderRow = pendingTerminal.requireRowContaining(
            "Wrote src/final-write.ts (+3)",
        );
        expectDefaultBackgroundWithoutDiffAttributes(completedHeaderRow);
        const completedAlphaRow = pendingTerminal.requireRowContaining("finalWriteAlpha");
        const completedBetaRow = pendingTerminal.requireRowContaining("finalWriteBeta");
        const completedGammaRow = pendingTerminal.requireRowContaining("finalWriteGamma");
        const completedAfterSentinelRow = pendingTerminal.requireRowContaining(afterSentinel);
        expect(completedAlphaRow.index).toBe(completedHeaderRow.index + 1);
        expect(completedBetaRow.index).toBe(completedAlphaRow.index + 1);
        expect(completedGammaRow.index).toBe(completedBetaRow.index + 1);
        expect(completedAfterSentinelRow.index).toBe(completedGammaRow.index + 1);
        expect(pendingTerminal.rowsMatching(/finalWrite(?:Alpha|Beta|Gamma)/)).toHaveLength(3);
        pendingTerminal.assertNeutralRange(completedAfterSentinelRow);
        pendingTerminal.assertNoWrappedRows();
        pendingTerminal.assertRowsFitWidth();
    });

    it("renders canonical edit argument transitions and a semantic success diff", async () => {
        const pendingTerminal = new VirtualTerminal(110, 30);
        const activeTui = createTui(pendingTerminal);
        activeTui.setClearOnShrink(true);
        const tool = new ToolExecutionComponent(
            "edit",
            "call-xterm-edit-lifecycle",
            {},
            undefined,
            undefined,
            activeTui,
            cwd,
        );
        const beforeSentinel = "BEFORE_EDIT_LIFECYCLE";
        const afterSentinel = "AFTER_EDIT_LIFECYCLE";
        activeTui.addChild(new LinesComponent([beforeSentinel]));
        activeTui.addChild(tool);
        activeTui.addChild(new LinesComponent([afterSentinel]));
        terminal = pendingTerminal;
        tui = activeTui;
        activeTui.start();
        await pendingTerminal.settle();

        let screen = pendingTerminal.screenText();
        expect(screen).toContain("Editing");
        expect(screen).not.toContain("undefined");
        expect(screen).not.toContain("{}");
        expect(screen).not.toContain(cwd);
        expect(screen).not.toContain(root);
        pendingTerminal.assertUniqueTranscriptMarkers("Editing", beforeSentinel, afterSentinel);
        expect(pendingTerminal.requireRowContaining("Editing").text.trimEnd()).toBe("• Editing");
        pendingTerminal.assertNeutralRange(
            pendingTerminal.requireRowContaining(beforeSentinel),
            0,
            pendingTerminal.columns,
        );
        pendingTerminal.assertNeutralRange(
            pendingTerminal.requireRowContaining(afterSentinel),
            0,
            pendingTerminal.columns,
        );

        tool.updateArgs({
            path: "src/obsolete-edit.ts",
            edits: [{ oldText: "obsoleteEditOld" }],
        });
        activeTui.requestRender();
        await pendingTerminal.settle();
        screen = pendingTerminal.screenText();
        expect(screen).toContain("Editing src/obsolete-edit.ts");
        expect(screen).not.toContain("invalid");
        pendingTerminal.assertUniqueTranscriptMarkers(
            "Editing src/obsolete-edit.ts",
            beforeSentinel,
            afterSentinel,
        );

        tool.updateArgs({
            path: "src/obsolete-edit.ts",
            edits: [
                { oldText: "obsoleteEditOld", newText: "obsoleteEditNew" },
                { oldText: "obsoleteSecondOld", newText: "obsoleteSecondNew" },
            ],
        });
        activeTui.requestRender();
        await pendingTerminal.settle();
        screen = pendingTerminal.screenText();
        expect(screen).toContain("Editing src/obsolete-edit.ts (2 edits)");
        expect(screen).not.toContain("invalid");
        expect(screen).not.toContain("obsoleteEditOld");
        expect(screen).not.toContain("obsoleteEditNew");
        for (const rawToken of [
            '"edits"',
            '"oldText"',
            '"newText"',
            "obsoleteEditOld",
            "obsoleteEditNew",
            "obsoleteSecondOld",
            "obsoleteSecondNew",
        ]) {
            expect(screen).not.toContain(rawToken);
        }
        pendingTerminal.assertUniqueTranscriptMarkers(
            "Editing src/obsolete-edit.ts (2 edits)",
            beforeSentinel,
            afterSentinel,
        );

        const finalPath = "src/final-edit.ts";
        tool.updateArgs({
            path: finalPath,
            edits: [{ oldText: "const obsoleteValue = 1;", newText: "const currentValue = 2;" }],
        });
        activeTui.requestRender();
        await pendingTerminal.settle();
        screen = pendingTerminal.screenText();
        const singleEditHeader = pendingTerminal.requireRowContaining("Editing src/final-edit.ts");
        expect(singleEditHeader.text.trimEnd()).toBe("• Editing src/final-edit.ts");
        expect(screen).not.toContain("(2 edits)");
        for (const obsoleteToken of [
            "src/obsolete-edit.ts",
            "obsoleteEditOld",
            "obsoleteEditNew",
            "obsoleteSecondOld",
            "obsoleteSecondNew",
            '"path"',
            '"edits"',
            '"oldText"',
            '"newText"',
        ]) {
            expect(screen).not.toContain(obsoleteToken);
        }
        pendingTerminal.assertUniqueTranscriptMarkers(
            "Editing src/final-edit.ts",
            beforeSentinel,
            afterSentinel,
        );

        tool.setArgsComplete();
        activeTui.requestRender();
        await pendingTerminal.settle();
        screen = pendingTerminal.screenText();
        expect(screen).toContain("Editing src/final-edit.ts");
        expect(screen).not.toContain("Edited src/final-edit.ts");
        for (const rawKey of ['"path"', '"edits"', '"oldText"', '"newText"']) {
            expect(screen).not.toContain(rawKey);
        }
        pendingTerminal.assertUniqueTranscriptMarkers(
            "Editing src/final-edit.ts",
            beforeSentinel,
            afterSentinel,
        );

        const oldContent =
            "export const stableContext = true;\nconst obsoleteValue = 1;\nexport const trailingContext = true;\n";
        const newContent =
            "export const stableContext = true;\nconst currentValue = 2;\nexport const trailingContext = true;\n";
        const payload = buildPierreDiffPayload({
            path: finalPath,
            oldContent,
            newContent,
            oldSizeBytes: Buffer.byteLength(oldContent),
            newSizeBytes: Buffer.byteLength(newContent),
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") throw new Error("expected renderable Pierre payload");
        const displayDiff =
            "src/final-edit.ts\n- 2 const obsoleteValue = 1;\n+ 2 const currentValue = 2;\n";
        const patch =
            "--- a/src/final-edit.ts\n+++ b/src/final-edit.ts\n@@ -1,3 +1,3 @@\n export const stableContext = true;\n-const obsoleteValue = 1;\n+const currentValue = 2;\n export const trailingContext = true;\n";
        const successText = "Successfully replaced text in src/final-edit.ts.";
        tool.updateResult({
            content: [{ type: "text", text: successText }],
            details: { diff: displayDiff, patch, firstChangedLine: 2, pierreDiff: payload },
            isError: false,
        });
        activeTui.requestRender();
        await pendingTerminal.settle();

        screen = pendingTerminal.screenText();
        expect(screen).toContain("Edited src/final-edit.ts (+1 -1)");
        expect(screen).toContain("stableContext");
        expect(screen).toContain("obsoleteValue");
        expect(screen).toContain("currentValue");
        expect(screen).toContain("trailingContext");
        expect(screen).not.toContain(successText);
        expect(screen).not.toContain("+0");
        expect(screen).not.toContain("-0");
        for (const obsoleteToken of [
            "src/obsolete-edit.ts",
            "obsoleteEditOld",
            "obsoleteEditNew",
            "obsoleteSecondOld",
            "obsoleteSecondNew",
        ]) {
            expect(screen).not.toContain(obsoleteToken);
        }
        pendingTerminal.assertUniqueTranscriptMarkers(
            "Edited src/final-edit.ts",
            beforeSentinel,
            afterSentinel,
        );
        const deletion = pendingTerminal.requireRowContaining("obsoleteValue");
        const addition = pendingTerminal.requireRowContaining("currentValue");
        const context = pendingTerminal.requireRowContaining("stableContext");
        const trailingContext = pendingTerminal.requireRowContaining("trailingContext");
        expect(new Set(deletion.cells.map((cell) => cell.background))).toEqual(
            new Set([
                rgbFromHex(DEFAULT_APPEARANCE.deletedRowBackground),
                rgbFromHex(DEFAULT_APPEARANCE.deletedContentBackground),
            ]),
        );
        expect(new Set(addition.cells.map((cell) => cell.background))).toEqual(
            new Set([
                rgbFromHex(DEFAULT_APPEARANCE.addedRowBackground),
                rgbFromHex(DEFAULT_APPEARANCE.addedContentBackground),
            ]),
        );
        expect(context.cells.every((cell) => cell.isBackgroundDefault)).toBe(true);
        expect(trailingContext.cells.every((cell) => cell.isBackgroundDefault)).toBe(true);
        const additionCode = requireDisplayCellSpan(addition, "const currentValue = 2;");
        const settledForegrounds = new Set(
            addition.cells
                .slice(additionCode.start, additionCode.end)
                .filter((cell) => cell.chars.trim().length > 0)
                .map((cell) =>
                    cell.isForegroundDefault
                        ? "default"
                        : `${cell.isForegroundRgb ? "rgb" : "palette"}:${cell.foreground}`,
                ),
        );
        expect(settledForegrounds.size).toBeGreaterThan(1);
        const deletionCodeColumn = deletion.text.indexOf("const obsoleteValue");
        const additionCodeColumn = addition.text.indexOf("const currentValue");
        expect(deletion.text.slice(0, deletionCodeColumn)).toBe("2   - ");
        expect(addition.text.slice(0, additionCodeColumn)).toBe("  2 + ");
        expect(deletion.cells[0]?.chars).toBe("2");
        expect(deletion.cells[0]?.foreground).toBe(DARK_THEME_DIM_FOREGROUND);
        expect(deletion.cells[2]?.chars).toBe(" ");
        expect(deletion.cells[4]?.chars).toBe("-");
        expect(deletion.cells[4]?.foreground).toBe(DARK_THEME_DELETED_FOREGROUND);
        expect(addition.cells[0]?.chars).toBe(" ");
        expect(addition.cells[2]?.chars).toBe("2");
        expect(addition.cells[2]?.foreground).toBe(DARK_THEME_DIM_FOREGROUND);
        expect(addition.cells[4]?.chars).toBe("+");
        expect(addition.cells[4]?.foreground).toBe(DARK_THEME_ADDED_FOREGROUND);
        const beforeSentinelRow = pendingTerminal.requireRowContaining(beforeSentinel);
        const afterSentinelRow = pendingTerminal.requireRowContaining(afterSentinel);
        pendingTerminal.assertNeutralRange(beforeSentinelRow, 0, pendingTerminal.columns);
        pendingTerminal.assertNeutralRange(afterSentinelRow, 0, pendingTerminal.columns);
        expect(afterSentinelRow.index).toBe(trailingContext.index + 1);
        pendingTerminal.assertNoWrappedRows();
        pendingTerminal.assertRowsFitWidth();
    });

    it("captures and retains a live Delete preimage through successful completion", async () => {
        const pendingTerminal = new VirtualTerminal(110, 30);
        const activeTui = createTui(pendingTerminal);
        activeTui.setClearOnShrink(true);
        const toolCallId = "call-xterm-delete-lifecycle";
        const tool = new ToolExecutionComponent(
            "Delete",
            toolCallId,
            {},
            undefined,
            undefined,
            activeTui,
            cwd,
        );
        const beforeSentinel = "BEFORE_DELETE_LIFECYCLE";
        const afterSentinel = "AFTER_DELETE_LIFECYCLE";
        activeTui.addChild(new LinesComponent([beforeSentinel]));
        activeTui.addChild(tool);
        activeTui.addChild(new LinesComponent([afterSentinel]));
        terminal = pendingTerminal;
        tui = activeTui;
        activeTui.start();
        await pendingTerminal.settle();

        let screen = pendingTerminal.screenText();
        expect(screen).toContain("Deleting");
        expect(screen).not.toContain("undefined");
        expect(screen).not.toContain("{}");
        pendingTerminal.assertUniqueTranscriptMarkers("Deleting", beforeSentinel, afterSentinel);

        const obsoletePath =
            "src/obsolete-delete\u001b[2J\u001b]2;delete-path-owned\u0007-with-long-tail.ts";
        const obsoleteDisplayPath =
            "src/obsolete-delete␛[2J␛]2;delete-path-owned␇-with-long-tail.ts";
        const obsoleteSuffix = "delete-path-owned";
        tool.updateArgs({ path: obsoletePath });
        activeTui.requestRender();
        await pendingTerminal.settle();
        screen = pendingTerminal.screenText();
        expect(screen).toContain(`Deleting ${obsoleteDisplayPath}`);
        const hostilePathWrites = pendingTerminal.rawWrites().join("");
        expect(hostilePathWrites).not.toContain("\u001b]2;delete-path-owned");
        expect(hostilePathWrites).not.toContain("delete-path-owned\u0007");
        pendingTerminal.assertUniqueTranscriptMarkers(
            `Deleting ${obsoleteDisplayPath}`,
            beforeSentinel,
            afterSentinel,
        );

        const finalRelativePath = "src/final-delete.ts";
        const finalAbsolutePath = join(cwd, finalRelativePath);
        mkdirSync(join(cwd, "src"), { recursive: true });
        const preimage =
            "export const deletedAlpha = 1;\nexport const deletedBeta = 2;\nexport const deletedGamma = 3;\n";
        writeFileSync(finalAbsolutePath, preimage);
        tool.updateArgs({ path: finalRelativePath });
        activeTui.requestRender();
        await pendingTerminal.settle();
        screen = pendingTerminal.screenText();
        expect(screen).toContain(`Deleting ${finalRelativePath}`);
        expect(screen).not.toContain(obsoleteDisplayPath);
        expect(screen).not.toContain(obsoleteSuffix);
        expect(screen).not.toContain("deletedAlpha");

        pendingTerminal.assertUniqueTranscriptMarkers(
            "Deleting src/final-delete.ts",
            beforeSentinel,
            afterSentinel,
        );
        const installedExtension = extension;
        if (installedExtension === undefined) throw new Error("extension must be installed");
        await installedExtension.emitToolCall(
            {
                type: "tool_call",
                toolName: "Delete",
                toolCallId,
                input: { path: finalRelativePath },
            },
            cwd,
        );
        expect(existsSync(finalAbsolutePath)).toBe(true);
        tool.updateArgs({ path: finalRelativePath });
        activeTui.requestRender();
        await pendingTerminal.settle();
        screen = pendingTerminal.screenText();
        expect(screen).toContain("Deleting src/final-delete.ts (-3)");
        expect(screen).toContain("deletedAlpha");
        expect(screen).toContain("deletedBeta");
        expect(screen).toContain("deletedGamma");
        pendingTerminal.assertUniqueTranscriptMarkers(
            "Deleting src/final-delete.ts",
            beforeSentinel,
            afterSentinel,
        );

        unlinkSync(finalAbsolutePath);
        expect(existsSync(finalAbsolutePath)).toBe(false);
        tool.setArgsComplete();
        const successText = "Successfully deleted src/final-delete.ts";
        tool.updateResult({
            content: [{ type: "text", text: successText }],
            details: undefined,
            isError: false,
        });
        activeTui.requestRender();
        await pendingTerminal.settle();

        screen = pendingTerminal.screenText();
        expect(screen).toContain("Deleted src/final-delete.ts (-3)");
        expect(screen).toContain("deletedAlpha");
        expect(screen).toContain("deletedBeta");
        expect(screen).toContain("deletedGamma");
        expect(screen).not.toContain(obsoleteDisplayPath);
        expect(screen).not.toContain(successText);
        pendingTerminal.assertUniqueTranscriptMarkers(
            "Deleted src/final-delete.ts",
            beforeSentinel,
            afterSentinel,
        );
        const completedDeleteHeader = pendingTerminal.requireRowContaining(
            "Deleted src/final-delete.ts (-3)",
        );
        expectDefaultBackgroundWithoutDiffAttributes(completedDeleteHeader);
        for (const [lineNumber, token] of [
            [1, "deletedAlpha"],
            [2, "deletedBeta"],
            [3, "deletedGamma"],
        ] as const) {
            const row = pendingTerminal.requireRowContaining(token);
            pendingTerminal.assertFullRowBackground(
                row,
                rgbFromHex(DEFAULT_APPEARANCE.deletedRowBackground),
            );
            const codeColumn = row.text.indexOf("export const");
            expect(codeColumn).toBeGreaterThan(0);
            expect(row.text.slice(0, codeColumn)).toBe(`    ${lineNumber}   -`);
            expect(row.cells[4]?.chars).toBe(String(lineNumber));
            expect(row.cells[4]?.foreground).toBe(DARK_THEME_DIM_FOREGROUND);
            expect(row.cells[6]?.chars).toBe(" ");
            expect(row.cells[8]?.chars).toBe("-");
            expect(row.cells[8]?.foreground).toBe(DARK_THEME_DELETED_FOREGROUND);
        }
        const deletionRows = pendingTerminal.rowsMatching(/deleted(?:Alpha|Beta|Gamma)/);
        expect(deletionRows).toHaveLength(3);
        expect(
            deletionRows.every((row) =>
                row.cells.every(
                    (cell) =>
                        cell.background !== rgbFromHex(DEFAULT_APPEARANCE.addedRowBackground) &&
                        cell.background !== rgbFromHex(DEFAULT_APPEARANCE.addedContentBackground),
                ),
            ),
        ).toBe(true);
        pendingTerminal.assertNeutralRange(
            pendingTerminal.requireRowContaining(beforeSentinel),
            0,
            pendingTerminal.columns,
        );
        pendingTerminal.assertNeutralRange(
            pendingTerminal.requireRowContaining(afterSentinel),
            0,
            pendingTerminal.columns,
        );
        pendingTerminal.assertNoWrappedRows();
        pendingTerminal.assertRowsFitWidth();
    });

    it("restores a completed Delete preview from persisted result details", async () => {
        const pendingTerminal = new VirtualTerminal(110, 20);
        const activeTui = createTui(pendingTerminal);
        const path = "src/restored-delete.ts";
        const beforeSentinel = "BEFORE_RESTORED_DELETE";
        const afterSentinel = "AFTER_RESTORED_DELETE";
        const tool = new ToolExecutionComponent(
            "Delete",
            "call-xterm-restored-delete",
            { path },
            undefined,
            undefined,
            activeTui,
            cwd,
        );
        tool.setArgsComplete();
        const successText = "Successfully deleted src/restored-delete.ts";
        tool.updateResult({
            content: [{ type: "text", text: successText }],
            details: {
                diff: `${path}\n-1 export const restoredDeletedAlpha = 1;\n-2 export const restoredDeletedBeta = 2;\n`,
            },
            isError: false,
        });
        activeTui.addChild(new LinesComponent([beforeSentinel]));
        activeTui.addChild(tool);
        activeTui.addChild(new LinesComponent([afterSentinel]));
        terminal = pendingTerminal;
        tui = activeTui;
        activeTui.start();
        await pendingTerminal.settle();

        const screen = pendingTerminal.screenText();
        expect(existsSync(join(cwd, path))).toBe(false);
        expect(screen).toContain("Deleted src/restored-delete.ts (-2)");
        expect(screen).toContain("restoredDeletedAlpha");
        expect(screen).toContain("restoredDeletedBeta");
        expect(screen).not.toContain(successText);
        pendingTerminal.assertUniqueTranscriptMarkers(
            "Deleted src/restored-delete.ts",
            beforeSentinel,
            afterSentinel,
        );
        const restoredHeader = pendingTerminal.requireRowContaining(
            "Deleted src/restored-delete.ts (-2)",
        );
        expectDefaultBackgroundWithoutDiffAttributes(restoredHeader);
        for (const [lineNumber, token] of [
            [1, "restoredDeletedAlpha"],
            [2, "restoredDeletedBeta"],
        ] as const) {
            const row = pendingTerminal.requireRowContaining(token);
            pendingTerminal.assertFullRowBackground(
                row,
                rgbFromHex(DEFAULT_APPEARANCE.deletedRowBackground),
            );
            const codeColumn = row.text.indexOf("export const");
            expect(codeColumn).toBeGreaterThan(0);
            expect(row.text.slice(0, codeColumn)).toBe(`    ${lineNumber}   -`);
            expect(row.cells[4]?.chars).toBe(String(lineNumber));
            expect(row.cells[4]?.foreground).toBe(DARK_THEME_DIM_FOREGROUND);
            expect(row.cells[6]?.chars).toBe(" ");
            expect(row.cells[8]?.chars).toBe("-");
            expect(row.cells[8]?.foreground).toBe(DARK_THEME_DELETED_FOREGROUND);
            expect(
                row.cells.every(
                    (cell) =>
                        cell.background !== rgbFromHex(DEFAULT_APPEARANCE.addedRowBackground) &&
                        cell.background !== rgbFromHex(DEFAULT_APPEARANCE.addedContentBackground),
                ),
            ).toBe(true);
        }
        pendingTerminal.assertNeutralRange(
            pendingTerminal.requireRowContaining(beforeSentinel),
            0,
            pendingTerminal.columns,
        );
        pendingTerminal.assertNeutralRange(
            pendingTerminal.requireRowContaining(afterSentinel),
            0,
            pendingTerminal.columns,
        );
        pendingTerminal.assertNoWrappedRows();
        pendingTerminal.assertRowsFitWidth();
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

    it("keeps multi-step Bash chains separated across wide-narrow-wide redraws", async () => {
        const pendingTerminal = new VirtualTerminal(110, 20);
        const activeTui = createTui(pendingTerminal);
        const tool = new ToolExecutionComponent(
            "bash",
            "call-xterm-bash-chain",
            {
                command: "uv run pytest feature/tests && just test feature && git status --short",
            },
            undefined,
            undefined,
            activeTui,
            cwd,
        );
        tool.setArgsComplete();
        activeTui.addChild(new LinesComponent(["BEFORE_BASH_CHAIN"]));
        activeTui.addChild(tool);
        activeTui.addChild(new LinesComponent(["AFTER_BASH_CHAIN"]));
        terminal = pendingTerminal;
        tui = activeTui;
        activeTui.start();
        await pendingTerminal.settle();

        expect(
            pendingTerminal.requireRowContaining("uv run pytest").text.trimEnd().endsWith("&&"),
        ).toBe(true);
        expect(
            pendingTerminal.requireRowContaining("just test feature").text.trimEnd().endsWith("&&"),
        ).toBe(true);
        pendingTerminal.requireRowContaining("git status --short");
        pendingTerminal.assertNoWrappedRows();

        pendingTerminal.resize(42, 20);
        await pendingTerminal.settle();
        expect(
            pendingTerminal.requireRowContaining("just test feature").text.trimEnd().endsWith("&&"),
        ).toBe(true);
        pendingTerminal.requireRowContaining("git status --short");
        pendingTerminal.assertNoWrappedRows();

        pendingTerminal.resize(110, 20);
        await pendingTerminal.settle();
        expect(
            pendingTerminal.requireRowContaining("uv run pytest").text.trimEnd().endsWith("&&"),
        ).toBe(true);
        expect(
            pendingTerminal.requireRowContaining("just test feature").text.trimEnd().endsWith("&&"),
        ).toBe(true);
        pendingTerminal.requireRowContaining("git status --short");
        pendingTerminal.assertNoWrappedRows();
        expect(pendingTerminal.countOccurrences("BEFORE_BASH_CHAIN")).toBe(1);
        expect(pendingTerminal.countOccurrences("AFTER_BASH_CHAIN")).toBe(1);
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
        expect(pendingTerminal.countOccurrences("BEFORE_SENTINEL")).toBe(1);
        expect(pendingTerminal.countOccurrences("AFTER_SENTINEL")).toBe(1);

        pendingTerminal.resize(70, 30);
        await pendingTerminal.settle();
        expect(pendingTerminal.screenText()).not.toContain(" │ ");
        pendingTerminal.assertNoWrappedRows();

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
        pendingTerminal.assertUniqueTranscriptMarkers(
            "Patched src/expanded.ts",
            "BEFORE_TRANSCRIPT",
            "AFTER_TRANSCRIPT",
        );

        tool.setExpanded(false);
        activeTui.requestRender();
        await pendingTerminal.settle();
        expect(pendingTerminal.screenText()).toBe(collapsed);
    });

    it.each(THEME_STYLE_PROFILES)(
        "isolates complete diff-row styles for $name",
        async ({
            theme,
            appearance,
            expectedAppearance,
            expectedAddedForeground,
            expectedDeletedForeground,
        }) => {
            await installExtension({ theme, appearance });
            const pendingTerminal = new VirtualTerminal(90, 30);
            const activeTui = createTui(pendingTerminal);
            const oldContent =
                "const removedOnly = true;\nconst unchangedA = true;\nconst unchangedB = true;\nconst previousValue = formatValue(oldToken);\nconst unchangedC = true;\n";
            const newContent =
                "const unchangedA = true;\nconst insertedOnly = false;\nconst unchangedB = true;\nexport const nextValue = formatValue(newToken);\n\n\t\nconst unchangedC = true;\n\treturn tabIndentedValue;\n";
            const payload = buildPierreDiffPayload({
                path: "src/colors.ts",
                oldContent,
                newContent,
                oldSizeBytes: Buffer.byteLength(oldContent),
                newSizeBytes: Buffer.byteLength(newContent),
                canBuildPierreDiff: true,
            });
            if (payload?.kind !== "renderable")
                throw new Error("expected renderable Pierre payload");
            const patch = `*** Begin Patch
*** Update File: src/colors.ts
@@
-const removedOnly = true;
 const unchangedA = true;
+const insertedOnly = false;
 const unchangedB = true;
-const previousValue = formatValue(oldToken);
+export const nextValue = formatValue(newToken);
+
+\t
 const unchangedC = true;
+\treturn tabIndentedValue;
*** End Patch`;
            const tool = new ToolExecutionComponent(
                "apply_patch",
                `call-xterm-style-${theme}-${expectedAppearance.addedRowBackground}`,
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
@@ -1,5 +1,8 @@
-const removedOnly = true;
 const unchangedA = true;
+const insertedOnly = false;
 const unchangedB = true;
-const previousValue = formatValue(oldToken);
+export const nextValue = formatValue(newToken);
+
+	
 const unchangedC = true;
+	return tabIndentedValue;
`,
                    lineSummary: {
                        files: [
                            {
                                action: "M",
                                path: "src/colors.ts",
                                addedLines: 5,
                                removedLines: 2,
                            },
                        ],
                    },
                },
                isError: false,
            });
            const sentinelText = "PLAIN_STYLE_SENTINEL";
            activeTui.addChild(tool);
            activeTui.addChild(new LinesComponent([sentinelText]));
            terminal = pendingTerminal;
            tui = activeTui;
            activeTui.start();
            await pendingTerminal.settle();

            const standaloneDeletion = pendingTerminal.requireRowContaining("removedOnly");
            const standaloneAddition = pendingTerminal.requireRowContaining("insertedOnly");
            const replacementDeletion = pendingTerminal.requireRowContaining("previousValue");
            const replacementAddition = pendingTerminal.requireRowContaining("nextValue");
            const weakAdditionRows = pendingTerminal.rowsMatching(/\+\s*$/);
            expect(weakAdditionRows).toHaveLength(2);
            const blankAddition = weakAdditionRows[0];
            const tabOnlyAddition = weakAdditionRows[1];
            if (blankAddition === undefined || tabOnlyAddition === undefined) {
                throw new Error("expected blank and tab-only addition rows");
            }
            const tabAddition = pendingTerminal.requireRowContaining("tabIndentedValue");
            const context = pendingTerminal.requireRowContaining("unchangedA");
            const header = pendingTerminal.requireRowContaining("Patched src/colors.ts");
            const sentinel = pendingTerminal.requireRowContaining(sentinelText);
            const addedRow = rgbFromHex(expectedAppearance.addedRowBackground);
            const deletedRow = rgbFromHex(expectedAppearance.deletedRowBackground);
            const addedContent = rgbFromHex(expectedAppearance.addedContentBackground);
            const deletedContent = rgbFromHex(expectedAppearance.deletedContentBackground);
            const addedForeground = rgbFromHex(expectedAddedForeground);
            const deletedForeground = rgbFromHex(expectedDeletedForeground);

            expect(new Set([addedRow, deletedRow, addedContent, deletedContent]).size).toBe(4);
            pendingTerminal.assertFullRowBackground(standaloneDeletion, deletedRow);
            pendingTerminal.assertFullRowBackground(standaloneAddition, addedRow);
            pendingTerminal.assertFullRowBackground(blankAddition, addedRow);
            pendingTerminal.assertFullRowBackground(tabOnlyAddition, addedRow);
            pendingTerminal.assertFullRowBackground(tabAddition, addedRow);
            expectRgbBackgrounds(
                replacementDeletion,
                [deletedRow, deletedContent],
                pendingTerminal.columns,
            );
            expectRgbBackgrounds(
                replacementAddition,
                [addedRow, addedContent],
                pendingTerminal.columns,
            );
            expect(standaloneDeletion.cells.every((cell) => cell.isBackgroundRgb)).toBe(true);
            expect(standaloneAddition.cells.every((cell) => cell.isBackgroundRgb)).toBe(true);
            expect(blankAddition.cells.every((cell) => cell.isBackgroundRgb)).toBe(true);
            expect(tabOnlyAddition.cells.every((cell) => cell.isBackgroundRgb)).toBe(true);
            expect(tabAddition.cells.every((cell) => cell.isBackgroundRgb)).toBe(true);
            expect(addedRow).not.toBe(deletedRow);

            const additionCode = requireDisplayCellSpan(
                replacementAddition,
                "export const nextValue = formatValue(newToken);",
            );
            const deletionMarker = requireDisplayCellSpan(replacementDeletion, "-");
            const additionMarker = requireDisplayCellSpan(replacementAddition, "+");
            expect(replacementDeletion.cells[deletionMarker.start]).toMatchObject({
                foreground: deletedForeground,
                isForegroundDefault: false,
                isForegroundRgb: true,
            });
            expect(replacementAddition.cells[additionMarker.start]).toMatchObject({
                foreground: addedForeground,
                isForegroundDefault: false,
                isForegroundRgb: true,
            });

            const unchangedDeletion = requireDisplayCellSpan(replacementDeletion, "formatValue(");
            const unchangedAddition = requireDisplayCellSpan(replacementAddition, "formatValue(");
            expectRgbBackgroundSpan(replacementDeletion, unchangedDeletion, deletedRow);
            expectRgbBackgroundSpan(replacementAddition, unchangedAddition, addedRow);

            const changedDeletion = requireDisplayCellSpan(replacementDeletion, "previousValue");
            const changedAddition = requireDisplayCellSpan(replacementAddition, "nextValue");
            expectRgbBackgroundSpan(replacementDeletion, changedDeletion, deletedContent);
            expectRgbBackgroundSpan(replacementAddition, changedAddition, addedContent);
            expect(replacementDeletion.cells.at(-1)?.background).toBe(deletedRow);
            expect(replacementAddition.cells.at(-1)?.background).toBe(addedRow);
            expect(replacementDeletion.cells.at(-1)?.isBackgroundRgb).toBe(true);
            expect(replacementAddition.cells.at(-1)?.isBackgroundRgb).toBe(true);

            const syntaxForegrounds = new Set(
                replacementAddition.cells
                    .slice(additionCode.start, additionCode.end)
                    .filter((cell) => cell.chars.trim().length > 0)
                    .map((cell) =>
                        cell.isForegroundDefault
                            ? "default"
                            : `${cell.isForegroundRgb ? "rgb" : "palette"}:${cell.foreground}`,
                    ),
            );
            expect(syntaxForegrounds.size).toBeGreaterThan(1);

            expectDefaultBackgroundWithoutDiffAttributes(context);
            expectDefaultBackgroundWithoutDiffAttributes(header);
            pendingTerminal.assertNeutralRange(
                context,
                context.text.length,
                pendingTerminal.columns,
            );
            pendingTerminal.assertNeutralRange(header, header.text.length, pendingTerminal.columns);
            pendingTerminal.assertNeutralRange(sentinel, 0, pendingTerminal.columns);
            const paddingRow = pendingTerminal.rowRange(sentinel.index + 1, sentinel.index + 2)[0];
            expect(paddingRow?.text).toBe("");
            if (paddingRow === undefined)
                throw new Error("expected blank padding after style sentinel");
            pendingTerminal.assertNeutralRange(paddingRow, 0, pendingTerminal.columns);

            for (const neutralRow of [context, header, sentinel, paddingRow]) {
                expect(
                    neutralRow.cells.every(
                        (cell) =>
                            cell.background !== addedRow &&
                            cell.background !== deletedRow &&
                            cell.background !== addedContent &&
                            cell.background !== deletedContent,
                    ),
                ).toBe(true);
            }
            pendingTerminal.assertNoWrappedRows();
            pendingTerminal.assertRowsFitWidth();
        },
    );

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
        configureAutocompleteCleanupPatch(true, cleanupPrototype);
        const editor: CleanupEditor = {
            tui: running.tui,
            content,
            autocompletePrefix: "/thi",
            active: true,
            isShowingAutocomplete() {
                return this.active;
            },
        };

        cleanupPrototype.clearAutocompleteUi.call(editor);
        await running.terminal.settle();

        expect(running.terminal.screenText().trimEnd()).toBe("EDITOR_PROMPT");
        expect(running.terminal.screenText()).not.toContain("stale completion");
        const cleanupWrites = running.terminal.rawWrites().slice(writesBeforeCleanup).join("");
        if (mode === "regular") {
            expect(cleanupWrites).toContain("\u001b[2J\u001b[H\u001b[3J");
        } else {
            expect(cleanupWrites).toContain("\u001b[1;1H\u001b[2K");
        }
        running.terminal.assertRowsFitWidth();
    });
});
