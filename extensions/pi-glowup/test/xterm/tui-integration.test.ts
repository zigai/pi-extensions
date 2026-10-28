import {
    createBashTool,
    createBashToolDefinition,
    createReadTool,
    createReadToolDefinition,
    createWriteToolDefinition,
    initTheme,
    ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
    getCapabilities,
    setCapabilities,
    TuiAltScreen,
    TuiMainScreen,
    type Component,
    type TUI,
} from "@earendil-works/pi-tui";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGlowupGlobalConfigPath } from "../../src/config/load.ts";
import { buildPierreDiffPayload } from "../../src/rendering/diff/payload.ts";
import {
    initializeSyntaxHighlighting,
    highlightSyntaxCode,
    loadSyntaxLanguageIfReady,
    onSyntaxHighlightComplete,
    settleSyntaxHighlights,
    syntaxHighlightCacheStats,
    syntaxHighlighterDiagnostics,
} from "../../src/rendering/syntax/highlighter.ts";
import type { ExtensionSettings } from "../../src/settings-input.ts";
import { getScriptFormatterWorkload } from "../../src/tools/built-in/bash/formatter.ts";
import { presentGlowupSnapshot } from "../../src/tools/protocol/streaming.ts";
import { configureAutocompleteCleanupPatch } from "../../src/pi/patches/autocomplete-cleanup.ts";
import { GlowupExtensionHarness } from "./extension-harness.ts";
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

class ObservedToolExecutionComponent extends ToolExecutionComponent {
    invalidations = 0;

    override invalidate(): void {
        this.invalidations += 1;
        super.invalidate();
    }
}

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
    readonly scriptPreview?: Partial<ExtensionSettings["scriptPreview"]>;
    readonly streaming?: ExtensionSettings["streaming"];

    readonly appearance?:
        | "default"
        | {
              readonly diffBackgroundStyle: "solid" | "two-tone";
              readonly addedRowBackground: string;
              readonly deletedRowBackground: string;
              readonly addedContentBackground: string;
              readonly deletedContentBackground: string;
          };

    readonly mutations?: {
        readonly defaultView?: "full" | "preview";
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
        expectedAddedForeground: "#337e58",
        expectedDeletedForeground: "#c8253d",
    },
    {
        name: "light theme with a custom four-color palette",
        theme: "light",
        appearance: LIGHT_CUSTOM_APPEARANCE,
        expectedAppearance: LIGHT_CUSTOM_APPEARANCE,
        expectedAddedForeground: "#337e58",
        expectedDeletedForeground: "#c8253d",
    },
    {
        name: "dark theme with the existing custom four-color palette",
        theme: "dark",
        appearance: DEFAULT_APPEARANCE,
        expectedAppearance: DEFAULT_APPEARANCE,
        expectedAddedForeground: "#68b78d",
        expectedDeletedForeground: "#ea7f81",
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

function codeForegrounds(row: InterpretedRow, code: string): Set<string> {
    const span = requireDisplayCellSpan(row, code);

    return new Set(
        row.cells
            .slice(span.start, span.end)
            .filter((cell) => cell.chars.trim().length > 0)
            .map((cell) => {
                if (cell.isForegroundDefault) return "default";
                if (cell.isForegroundRgb) return `rgb:${cell.foreground}`;
                return `palette:${cell.foreground}`;
            }),
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

const DARK_THEME_DIM_FOREGROUND = rgbFromHex("#7e888e");
const DARK_THEME_ADDED_FOREGROUND = rgbFromHex("#68b78d");
const DARK_THEME_DELETED_FOREGROUND = rgbFromHex("#ea7f81");

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
        const config = Object.assign(
            { toolLabels: { mode: "lifecycle" } },
            appearance,
            profile.mutations !== undefined ? { mutations: profile.mutations } : undefined,
        );
        if (profile.scriptPreview !== undefined) {
            Object.assign(config, { scriptPreview: profile.scriptPreview });
        }

        if (profile.streaming !== undefined)
            Object.assign(config, { streaming: profile.streaming });

        writeFileSync(getGlowupGlobalConfigPath(agentDir), JSON.stringify(config));
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

    it("settles a long highlighted transcript without invalidating unrelated tool rows", async () => {
        await extension?.emitToolCall(
            {
                type: "tool_call",
                toolName: "read",
                toolCallId: "syntax-start",
                input: { path: "sample.ts" },
            },
            cwd,
        );
        await initializeSyntaxHighlighting();
        expect(await loadSyntaxLanguageIfReady("typescript")).toBe(true);
        await settleSyntaxHighlights();

        const pendingTerminal = new VirtualTerminal(100, 30);
        const activeTui = createTui(pendingTerminal);
        const passive = new ObservedToolExecutionComponent(
            "write",
            "plain-history",
            { path: "notes.txt", content: "A plain historical note." },
            undefined,
            createWriteToolDefinition(cwd),
            activeTui,
            cwd,
        );
        passive.setArgsComplete();
        passive.updateResult({ content: [], isError: false });
        passive.render(100);
        await settleSyntaxHighlights();
        const initialInvalidations = passive.invalidations;
        const tools: ToolExecutionComponent[] = [];
        let completions = 0;
        const stopCounting = onSyntaxHighlightComplete(() => {
            completions += 1;
        });
        try {
            for (let index = 0; index < 120; index += 1) {
                const tool = new ToolExecutionComponent(
                    "read",
                    `historical-code-${index}`,
                    { path: `sample-${index}.ts` },
                    undefined,
                    createReadToolDefinition(cwd),
                    activeTui,
                    cwd,
                );
                tool.setArgsComplete();
                tool.setExpanded(true);
                tool.updateResult({
                    content: [{ type: "text", text: `export const sample${index} = ${index};` }],
                    isError: false,
                });
                tool.render(100);
                await settleSyntaxHighlights();
                tools.push(tool);
            }

            expect(passive.invalidations).toBe(initialInvalidations);
            expect(completions).toBeGreaterThan(0);
            const settledCompletions = completions;
            terminal = pendingTerminal;
            tui = activeTui;

            for (const tool of tools) activeTui.addChild(tool);
            activeTui.addChild(passive);
            activeTui.start();
            await pendingTerminal.settle();

            for (let repaint = 0; repaint < 3; repaint += 1) {
                activeTui.requestRender();
                await pendingTerminal.settle();
                await settleSyntaxHighlights();
                expect(completions).toBe(settledCompletions);
            }

            const source = "export const sample119 = 119;";
            expect(
                codeForegrounds(pendingTerminal.requireRowContaining(source), source).size,
            ).toBeGreaterThan(1);

            pendingTerminal.assertRowsFitWidth();
        } finally {
            stopCounting();

            if (terminal !== pendingTerminal) pendingTerminal.dispose();
        }
    });

    it.each([
        {
            language: "python",
            label: "Python",
            header: "$ python - <<'PY'",
            firstLine: 'large_native_marker = "ready"',
            comment: "#",
            command: (source: string) => `python - <<'PY'\n${source}\nPY`,
        },
        {
            language: "javascript",
            label: "Node",
            header: "$ node - <<'JS'",
            firstLine: 'const largeNativeMarker = "ready";',
            comment: "//",
            command: (source: string) => `node - <<'JS'\n${source}\nJS`,
        },
    ])(
        "retains completed native $label worker colors above the shared-cache source budget",
        async ({ language, header, firstLine, comment, command }) => {
            await initializeSyntaxHighlighting({}, { preloadLanguages: [language] });
            const source = [
                firstLine,
                ...Array.from(
                    { length: 140 },
                    (_, index) => `${comment} retained native row ${index} ${"padding ".repeat(7)}`,
                ),
            ].join("\n");
            expect(Buffer.byteLength(source)).toBeGreaterThan(8 * 1024);
            expect(Buffer.byteLength(source)).toBeLessThan(40 * 1024);
            expect(syntaxHighlighterDiagnostics().loadedLanguages).toContain(language);
            expect(syntaxHighlightCacheStats().entries).toBe(0);

            const pendingTerminal = new VirtualTerminal(100, 24);
            const activeTui = createTui(pendingTerminal);
            const tool = new ToolExecutionComponent(
                "bash",
                `completed-native-${language}`,
                {},
                undefined,
                createBashToolDefinition(cwd),
                activeTui,
                cwd,
            );

            // Populate completed history without first warming this source in a streaming slot.
            tool.setArgsComplete();
            tool.updateResult({ content: [], isError: false });
            tool.updateArgs({ command: command(source) });
            const initial = tool.render(100).join("\n");
            expect(stripVTControlCharacters(initial)).toContain(firstLine);
            expect(stripVTControlCharacters(initial)).toContain(header);

            let completions = 0;
            const stopCounting = onSyntaxHighlightComplete(() => {
                completions += 1;
            });
            try {
                activeTui.addChild(new LinesComponent(["BEFORE_NATIVE_SYNTAX"]));
                activeTui.addChild(tool);
                activeTui.addChild(new LinesComponent(["AFTER_NATIVE_SYNTAX"]));
                terminal = pendingTerminal;
                tui = activeTui;
                activeTui.start();
                await vi.waitUntil(() => completions > 0);
                await pendingTerminal.settle();

                expect(
                    codeForegrounds(pendingTerminal.requireRowContaining(firstLine), firstLine)
                        .size,
                ).toBeGreaterThan(1);
                await settleSyntaxHighlights();
                expect(syntaxHighlightCacheStats().entries).toBe(0);
                const settledCompletions = completions;

                // Unrelated transcript repaints must neither lose colors nor submit another job.
                for (let repaint = 0; repaint < 3; repaint += 1) {
                    activeTui.requestRender();
                    await pendingTerminal.settle();
                    await settleSyntaxHighlights();
                    expect(
                        codeForegrounds(pendingTerminal.requireRowContaining(firstLine), firstLine)
                            .size,
                    ).toBeGreaterThan(1);

                    expect(completions).toBe(settledCompletions);
                }

                pendingTerminal.assertUniqueTranscriptMarkers(
                    header,
                    "BEFORE_NATIVE_SYNTAX",
                    "AFTER_NATIVE_SYNTAX",
                );
                pendingTerminal.assertNoWrappedRows();
                pendingTerminal.assertRowsFitWidth();
            } finally {
                stopCounting();
            }
        },
    );

    it("keeps statement-streamed tool colors through native row rebuilds without retokenizing", async () => {
        await installExtension({ streaming: { prose: "sentence", code: "statement" } });
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["python"] });
        const firstLine = 'statement_native_marker = "ready"';
        const source = [
            firstLine,
            ...Array.from(
                { length: 140 },
                (_, index) => `# statement native row ${index} ${"padding ".repeat(7)}`,
            ),
        ].join("\n");
        expect(Buffer.byteLength(source)).toBeGreaterThan(8 * 1024);
        const pendingTerminal = new VirtualTerminal(100, 24);
        const activeTui = createTui(pendingTerminal);
        const toolCallId = "statement-native-syntax";
        const tool = new ToolExecutionComponent(
            "bash",
            toolCallId,
            { command: `python - <<'PY'\n${source}\nPY` },
            undefined,
            createBashToolDefinition(cwd),
            activeTui,
            cwd,
        );
        tool.setArgsComplete();
        tool.updateResult({ content: [], isError: false });
        tool.render(100);
        await vi.waitFor(() => {
            tool.invalidate();
            expect(stripVTControlCharacters(tool.render(100).join("\n"))).toContain(firstLine);
        });

        // Settle the real statement worker separately from the real syntax worker.
        await presentGlowupSnapshot({
            key: "xterm:statement-worker-barrier",
            kind: "prose",
            source: "",
            complete: true,
        });
        tool.invalidate();
        tool.render(100);
        await settleSyntaxHighlights();
        tool.invalidate();
        const settled = tool.render(100);
        expect(stripVTControlCharacters(settled.join("\n"))).toContain(firstLine);
        expect(
            settled.find((line) => stripVTControlCharacters(line).includes(firstLine)),
        ).toContain("\u001b[");
        const completions = vi.fn<() => void>();
        const stopCounting = onSyntaxHighlightComplete(completions);
        try {
            terminal = pendingTerminal;
            tui = activeTui;
            activeTui.addChild(new LinesComponent(["BEFORE_STATEMENT_SYNTAX"]));
            activeTui.addChild(tool);
            activeTui.addChild(new LinesComponent(["AFTER_STATEMENT_SYNTAX"]));
            activeTui.start();
            await pendingTerminal.settle();

            for (let repaint = 0; repaint < 3; repaint += 1) {
                tool.invalidate();
                expect(tool.render(100)).toEqual(settled);
                activeTui.requestRender();
                await pendingTerminal.settle();
                await settleSyntaxHighlights();
                expect(
                    codeForegrounds(pendingTerminal.requireRowContaining(firstLine), firstLine)
                        .size,
                ).toBeGreaterThan(1);

                expect(completions).not.toHaveBeenCalled();
            }

            pendingTerminal.assertUniqueTranscriptMarkers(
                "$ python - <<'PY'",
                "BEFORE_STATEMENT_SYNTAX",
                "AFTER_STATEMENT_SYNTAX",
            );
            pendingTerminal.assertNoWrappedRows();
            pendingTerminal.assertRowsFitWidth();
        } finally {
            stopCounting();
        }
    });

    it("retains native script prefix colors as streamed arguments complete and the result arrives", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["python"] });
        const firstLine = 'streamed_native_marker = "ready"';
        const command = (source: string) => `python - <<'PY'\n${source}\nPY`;
        const pendingTerminal = new VirtualTerminal(100, 24);
        const activeTui = createTui(pendingTerminal);
        await extension?.startAssistantToolCall("bash", "streamed-native-syntax");
        const tool = new ToolExecutionComponent(
            "bash",
            "streamed-native-syntax",
            {},
            undefined,
            createBashToolDefinition(cwd),
            activeTui,
            cwd,
        );
        const initialSource = `${firstLine}\nprint(streamed_native_marker)`;
        tool.updateArgs({ command: command(initialSource) });
        await vi.waitFor(() => {
            tool.invalidate();
            const text = stripVTControlCharacters(tool.render(100).join("\n"));
            expect(text).toContain(firstLine);
            expect(text).not.toMatch(/\n\s*PY\s*$/u);
        });
        await settleSyntaxHighlights();
        tool.invalidate();
        const initialRow = tool
            .render(100)
            .find((line) => stripVTControlCharacters(line).includes(firstLine));
        expect(initialRow).toContain("\u001b[");

        activeTui.addChild(tool);
        terminal = pendingTerminal;
        tui = activeTui;
        activeTui.start();
        await pendingTerminal.settle();
        expect(
            codeForegrounds(pendingTerminal.requireRowContaining(firstLine), firstLine).size,
        ).toBeGreaterThan(1);

        const source = [
            initialSource,
            ...Array.from(
                { length: 140 },
                (_, index) => `# appended native row ${index} ${"padding ".repeat(7)}`,
            ),
        ].join("\n");
        expect(Buffer.byteLength(source)).toBeGreaterThan(8 * 1024);
        tool.updateArgs({ command: command(source) });
        tool.setArgsComplete();
        tool.markExecutionStarted();

        // This synchronous render happens before the new worker result can arrive.
        expect(
            tool.render(100).find((line) => stripVTControlCharacters(line).includes(firstLine)),
        ).toBe(initialRow);

        await settleSyntaxHighlights();
        tool.updateResult({ content: [], isError: false });
        activeTui.requestRender();
        await pendingTerminal.settle();
        expect(
            codeForegrounds(pendingTerminal.requireRowContaining(firstLine), firstLine).size,
        ).toBeGreaterThan(1);

        pendingTerminal.assertNoWrappedRows();
        pendingTerminal.assertRowsFitWidth();
    });

    it.each(["stationary", "measured"])(
        "recovers completed formatted Python colors at the same narrow width (%s)",
        async (driving) => {
            await installExtension({
                streaming: { prose: "paragraph", code: "statement" },
                scriptPreview: {
                    formatters: {
                        python: {
                            kind: "command",
                            command: [
                                process.execPath,
                                "-e",
                                "let source='';process.stdin.on('data',chunk=>source+=chunk);process.stdin.on('end',()=>process.stdout.write(Number(process.argv[1])<100?source.replace(/(replacements = \\{)(.*)(\\})/,(_all,head,body,tail)=>head+'\\n    '+body.replaceAll(', ',',\\n    ')+'\\n'+tail):source));",
                                "{width}",
                            ],
                        },
                    },
                },
            });
            await initializeSyntaxHighlighting(process.env, {
                preloadLanguages: ["bash", "python"],
            });
            for (let index = 0; index < 140; index += 1)
                highlightSyntaxCode(`print("invented_history_${index}")`, "python");
            let initialColumns = 80;
            if (driving === "measured") initialColumns = 200;
            const pendingTerminal = new VirtualTerminal(initialColumns, 40);
            const activeTui = createTui(pendingTerminal);
            const source = [
                "from pathlib import Path",
                "",
                'replacements = {"first/invented/template.py": "alpha", "second/invented/template.py": "beta", "third/invented/template.py": "gamma"}',
                "for filename, label in replacements.items():",
                "    path = Path(filename)",
                "    text = path.read_text()",
                '    text = text.replace("old value", label)',
                "    path.write_text(text)",
                'print("finished")',
            ].join("\n");
            const command = `python3 - <<'PY'\n${source}\nPY`;
            const tool = new ToolExecutionComponent(
                "bash",
                "invented-narrow-recovery",
                { command },
                undefined,
                createBashToolDefinition(cwd),
                activeTui,
                cwd,
            );
            tool.setArgsComplete();
            tool.updateResult({ content: [], isError: false });
            terminal = pendingTerminal;
            tui = activeTui;
            activeTui.addChild(new LinesComponent(["BEFORE_NARROW_RECOVERY"]));
            activeTui.addChild(tool);
            activeTui.addChild(new LinesComponent(["AFTER_NARROW_RECOVERY"]));
            activeTui.start();

            for (const expanded of [false, true, false]) {
                tool.setExpanded(expanded);
                for (const columns of [80, 120, 200, 80]) {
                    let terminalColumns = columns;
                    if (driving === "measured") terminalColumns = 200;
                    pendingTerminal.resize(terminalColumns, 40);
                    for (let pass = 0; pass < 3; pass += 1) {
                        tool.render(columns);
                        await pendingTerminal.settle();
                        await presentGlowupSnapshot({
                            key: "xterm:narrow-recovery-barrier",
                            kind: "prose",
                            source: "",
                            complete: true,
                        });
                        await vi.waitUntil(() => getScriptFormatterWorkload().active === 0);
                        await settleSyntaxHighlights();
                        // A repaint must not need a forced tool/component invalidation to get colors.
                        activeTui.requestRender();
                    }
                    await pendingTerminal.settle();
                    const raw = tool.render(columns);
                    const code = "replacements = {";
                    const measuredRow = raw.find((line) =>
                        stripVTControlCharacters(line).includes(code),
                    );
                    expect(measuredRow).toMatch(/\u001b\[38;2;/u);
                    const row = pendingTerminal.requireRowContaining(code);
                    expect(codeForegrounds(row, code).size).toBeGreaterThan(1);
                    expect(codeForegrounds(row, code)).not.toContain("default");
                    pendingTerminal.assertUniqueTranscriptMarkers(
                        "$ python3 - <<'PY'",
                        "BEFORE_NARROW_RECOVERY",
                        "AFTER_NARROW_RECOVERY",
                    );
                    pendingTerminal.assertRowsFitWidth();
                }
            }
        },
    );

    it("renders completed Python blocks through completion, expansion and resize", async () => {
        await installExtension({
            streaming: { prose: "paragraph", code: "statement" },
            scriptPreview: {
                formatters: {
                    python: {
                        kind: "command",
                        command: [
                            process.execPath,
                            "-e",
                            "let code='';process.stdin.on('data',chunk=>code+=chunk);process.stdin.on('end',()=>{if(!code.startsWith('try:\\n')||!code.includes('except ValueError:\\n')){process.exitCode=2;return;}process.stdout.write(code.replaceAll('\\n value=','\\n    value = '));})",
                        ],
                    },
                },
            },
        });
        const pendingTerminal = new VirtualTerminal(80, 24);
        const activeTui = createTui(pendingTerminal);
        const command = "python - <<'PY'\ntry:\n value=1\nexcept ValueError:\n value=2\nPY";
        const tool = new ToolExecutionComponent(
            "bash",
            "python-try-format",
            { command },
            undefined,
            createBashToolDefinition(cwd),
            activeTui,
            cwd,
        );
        tool.setArgsComplete();
        activeTui.addChild(new LinesComponent(["BEFORE_PYTHON_TRY"]));
        activeTui.addChild(tool);
        activeTui.addChild(new LinesComponent(["AFTER_PYTHON_TRY"]));
        terminal = pendingTerminal;
        tui = activeTui;
        activeTui.start();

        for (const columns of [80, 40, 100]) {
            pendingTerminal.resize(columns, 24);
            await pendingTerminal.settle();
            await presentGlowupSnapshot({
                key: "xterm:python-try-barrier",
                kind: "prose",
                source: "",
                complete: true,
            });
            await vi.waitUntil(async () => {
                tool.invalidate();
                activeTui.requestRender();
                await pendingTerminal.settle();

                if (columns !== 80) return pendingTerminal.screenText().includes("value=1");
                return pendingTerminal.screenText().includes("value = 1");
            });
            tool.invalidate();
            activeTui.requestRender();
            await pendingTerminal.settle();
            const screen = pendingTerminal.screenText();
            if (columns === 80)
                expect(screen).toContain(
                    "\n  try:\n      value = 1\n  except ValueError:\n      value = 2",
                );
            else expect(screen).toContain("\n  try:\n   value=1\n  except ValueError:\n   value=2");

            expect(screen).not.toContain("finally:");
            expect(screen).not.toContain("__glowup_");
            expect(screen).not.toContain("display formatter");
            pendingTerminal.assertUniqueTranscriptMarkers(
                "$ python - <<'PY'",
                "BEFORE_PYTHON_TRY",
                "AFTER_PYTHON_TRY",
            );
            pendingTerminal.assertNoWrappedRows();
            pendingTerminal.assertRowsFitWidth();
            tool.updateResult({ content: [], isError: false });
            tool.setExpanded(true);
        }
    });

    it("preserves nested heredoc payload and delimiter rows through statement rendering and resize", async () => {
        await installExtension({
            streaming: { prose: "paragraph", code: "statement" },
            scriptPreview: {
                formatters: {
                    bash: {
                        kind: "command",
                        command: [
                            process.execPath,
                            "-e",
                            "let code='';process.stdin.on('data',chunk=>code+=chunk);process.stdin.on('end',()=>process.stdout.write(code.replace(/^(# __glowup_unit_\\d+__end|:)$/gm,'  $1')));",
                        ],
                    },
                },
            },
        });
        const pendingTerminal = new VirtualTerminal(80, 24);
        const activeTui = createTui(pendingTerminal);
        const command = "if true; then\n cat <<EOF\nHEREDOC_LITERAL_ROW\nEOF\nfi";
        const tool = new ToolExecutionComponent(
            "bash",
            "heredoc-literal-format",
            { command },
            undefined,
            createBashToolDefinition(cwd),
            activeTui,
            cwd,
        );
        tool.setArgsComplete();
        tool.updateResult({ content: [], isError: false });
        activeTui.addChild(new LinesComponent(["BEFORE_HEREDOC_LITERAL"]));
        activeTui.addChild(tool);
        activeTui.addChild(new LinesComponent(["AFTER_HEREDOC_LITERAL"]));
        terminal = pendingTerminal;
        tui = activeTui;
        activeTui.start();

        for (const columns of [80, 40, 100]) {
            pendingTerminal.resize(columns, 24);
            await pendingTerminal.settle();
            await presentGlowupSnapshot({
                key: "xterm:heredoc-literal-barrier",
                kind: "prose",
                source: "",
                complete: true,
            });
            tool.invalidate();
            activeTui.requestRender();
            await pendingTerminal.settle();
            expect(pendingTerminal.requireRowContaining("HEREDOC_LITERAL_ROW").text.trimEnd()).toBe(
                "  HEREDOC_LITERAL_ROW",
            );

            expect(
                pendingTerminal
                    .screenText()
                    .split("\n")
                    .map((line) => line.trimEnd()),
            ).toContain("  EOF");

            expect(pendingTerminal.screenText()).not.toContain("__glowup_");
            pendingTerminal.assertUniqueTranscriptMarkers(
                "$ if true; then",
                "BEFORE_HEREDOC_LITERAL",
                "AFTER_HEREDOC_LITERAL",
            );
            pendingTerminal.assertNoWrappedRows();
            pendingTerminal.assertRowsFitWidth();
            tool.setExpanded(true);
        }
    });

    it("publishes whole-shell formatter output at the rendered width without changing execution or expanded source", async () => {
        const formatterOutput = join(cwd, "shell-formatter-output.txt");
        await installExtension({
            scriptPreview: {
                shellLayout: "preserve",
                formatters: {
                    bash: {
                        kind: "command",
                        command: [
                            process.execPath,
                            "-e",
                            "let source='';process.stdin.on('data',chunk=>source+=chunk);process.stdin.on('end',()=>{const formatted='# FORMAT_WIDTH_'+process.argv[1]+'\\n'+source;require('node:fs').writeFileSync(process.argv[2],formatted);process.stdout.write(formatted)})",
                            "{width}",
                            formatterOutput,
                        ],
                    },
                },
            },
        });
        const installedExtension = extension;
        if (installedExtension === undefined) throw new Error("extension must be installed");

        const command = "printf '%s\\n' SHELL_EXECUTION\n: ORIGINAL_TAIL";
        const args = Object.freeze({ command });
        const toolCallId = "whole-shell-formatter";
        const executedCommands: string[] = [];
        const nativeBash = createBashTool(cwd, {
            spawnHook(context) {
                executedCommands.push(context.command);
                return context;
            },
        });
        const pendingTerminal = new VirtualTerminal(80, 24);
        const activeTui = createTui(pendingTerminal);
        const tool = new ToolExecutionComponent(
            "bash",
            toolCallId,
            args,
            undefined,
            createBashToolDefinition(cwd),
            activeTui,
            cwd,
        );
        tool.setArgsComplete();

        // The installed extension's registered pre-execution handler, not a preview-store helper.
        await installedExtension.emitToolCall(
            { type: "tool_call", toolName: "bash", toolCallId, input: args },
            cwd,
        );
        tool.markExecutionStarted();
        const result = await nativeBash.execute(toolCallId, args);
        expect(result.content).toEqual([{ type: "text", text: "SHELL_EXECUTION\n" }]);
        expect(executedCommands).toEqual([command]);
        expect(args).toEqual({ command });
        tool.updateResult({ ...result, isError: false });
        activeTui.addChild(tool);
        terminal = pendingTerminal;
        tui = activeTui;
        activeTui.start();

        await pendingTerminal.settle();
        await vi.waitUntil(
            () => existsSync(formatterOutput) && getScriptFormatterWorkload().active === 0,
        );
        await pendingTerminal.settle();

        // Prove the real subprocess produced valid display code even if the renderer drops it.
        expect(readFileSync(formatterOutput, "utf8")).toMatch(/^# FORMAT_WIDTH_\d+\n/u);

        // The prompt renderer reserves four columns for soft-wrap continuation prefixes.
        expect(pendingTerminal.screenText()).toContain("$ # FORMAT_WIDTH_76");
        expect(readFileSync(formatterOutput, "utf8")).toBe(`# FORMAT_WIDTH_76\n${command}`);
        pendingTerminal.assertRowsFitWidth();
        pendingTerminal.resize(50, 24);
        await pendingTerminal.settle();
        await vi.waitUntil(() => getScriptFormatterWorkload().active === 0);
        await pendingTerminal.settle();
        expect(pendingTerminal.screenText()).toContain("$ # FORMAT_WIDTH_46");
        expect(readFileSync(formatterOutput, "utf8")).toBe(`# FORMAT_WIDTH_46\n${command}`);
        expect(pendingTerminal.screenText()).not.toContain("# FORMAT_WIDTH_76");
        pendingTerminal.assertNoWrappedRows();
        pendingTerminal.assertRowsFitWidth();

        tool.setExpanded(true);
        activeTui.requestRender();
        await pendingTerminal.settle();
        const expandedRows = stripVTControlCharacters(tool.render(50).join("\n")).split("\n");
        const callStart = expandedRows.findIndex((line) => line.startsWith("$ "));
        const resultStart = expandedRows.findIndex((line) => line.startsWith("  └"));
        const expandedCode = expandedRows
            .slice(callStart, resultStart)
            .map((line) => line.slice(2))
            .join("\n");
        expect(expandedCode).toBe(command);
        expect(pendingTerminal.screenText()).not.toContain("FORMAT_WIDTH_");
        expect(args).toEqual({ command });
        expect(executedCommands).toEqual([command]);
        await vi.waitUntil(() => getScriptFormatterWorkload().active === 0);
    });

    it("keeps native image read results reusable through expansion and resize", async () => {
        const pendingTerminal = new VirtualTerminal(100, 24);
        const activeTui = createTui(pendingTerminal);
        const definition = createReadToolDefinition(cwd);
        const nativeResult = vi.spyOn(definition, "renderResult");
        const tool = new ToolExecutionComponent(
            "read",
            "image-read",
            { path: "image.png" },
            { showImages: false },
            definition,
            activeTui,
            cwd,
        );
        tool.setArgsComplete();
        tool.updateResult({
            content: [
                { type: "text", text: "Image dimensions: 8 by 8" },
                { type: "image", data: "", mimeType: "image/png" },
            ],
            isError: false,
        });

        activeTui.addChild(new LinesComponent(["BEFORE_IMAGE_READ"]));
        activeTui.addChild(tool);
        activeTui.addChild(new LinesComponent(["AFTER_IMAGE_READ"]));
        terminal = pendingTerminal;
        tui = activeTui;
        activeTui.start();
        await pendingTerminal.settle();
        expect(pendingTerminal.screenText()).not.toContain("Image dimensions");

        for (const columns of [100, 55, 120]) {
            tool.setExpanded(true);
            pendingTerminal.resize(columns, 24);
            activeTui.requestRender();
            await pendingTerminal.settle();
            pendingTerminal.assertUniqueTranscriptMarkers(
                "Image dimensions: 8 by 8",
                "BEFORE_IMAGE_READ",
                "AFTER_IMAGE_READ",
            );
            pendingTerminal.assertRowsFitWidth();
            const settled = pendingTerminal.interpretedRows();
            tool.invalidate();
            activeTui.requestRender();
            await pendingTerminal.settle();
            expect(pendingTerminal.interpretedRows()).toEqual(settled);
            tool.setExpanded(false);
            activeTui.requestRender();
            await pendingTerminal.settle();
            expect(pendingTerminal.screenText()).not.toContain("Image dimensions");
        }

        expect(nativeResult).toHaveBeenCalled();
        expect(nativeResult.mock.results.every((result) => result.type === "return")).toBe(true);
    });

    it.each(["small", "above-shared-cache-budget"])(
        "repaints completed native read syntax at the same width without an expansion toggle (%s)",
        async (size) => {
            await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
            const firstLine = 'const readWorkerMarker = "ready";';
            let source = firstLine;

            if (size === "above-shared-cache-budget") {
                source +=
                    "\n" +
                    Array.from(
                        { length: 140 },
                        (_, index) => `// read row ${index} ${"padding ".repeat(8)}`,
                    ).join("\n");
                expect(Buffer.byteLength(source)).toBeGreaterThan(8 * 1024);
            }

            expect(Buffer.byteLength(source)).toBeLessThan(40 * 1024);
            const path = `read-worker-${size}.js`;
            writeFileSync(join(cwd, path), source);
            const result = await createReadTool(cwd).execute(`read-${size}`, { path });
            expect(result.content).toEqual([{ type: "text", text: source }]);
            expect(syntaxHighlighterDiagnostics().loadedLanguages).toContain("javascript");
            expect(syntaxHighlightCacheStats().entries).toBe(0);
            const pendingTerminal = new VirtualTerminal(100, 160);
            const activeTui = createTui(pendingTerminal);
            const tool = new ToolExecutionComponent(
                "read",
                `read-${size}`,
                { path },
                undefined,
                createReadToolDefinition(cwd),
                activeTui,
                cwd,
            );
            tool.setArgsComplete();

            // Read output is intentionally hidden when collapsed. Keep this state throughout.
            tool.setExpanded(true);
            tool.updateResult({ ...result, isError: false });
            expect(tool.render(100).join("\n")).toContain(firstLine);
            let completions = 0;
            const stopCounting = onSyntaxHighlightComplete(() => {
                completions += 1;
            });
            try {
                activeTui.addChild(new LinesComponent(["BEFORE_READ_SYNTAX"]));
                activeTui.addChild(tool);
                activeTui.addChild(new LinesComponent(["AFTER_READ_SYNTAX"]));
                terminal = pendingTerminal;
                tui = activeTui;
                activeTui.start();
                await settleSyntaxHighlights();
                await pendingTerminal.settle();

                expect(completions).toBeGreaterThan(0);
                expect(
                    codeForegrounds(pendingTerminal.requireRowContaining(firstLine), firstLine)
                        .size,
                ).toBeGreaterThan(1);
                const settledCompletions = completions;
                activeTui.requestRender();
                await pendingTerminal.settle();
                await settleSyntaxHighlights();
                expect(
                    codeForegrounds(pendingTerminal.requireRowContaining(firstLine), firstLine)
                        .size,
                ).toBeGreaterThan(1);

                expect(completions).toBe(settledCompletions);
                pendingTerminal.assertUniqueTranscriptMarkers(
                    "Explored",
                    "BEFORE_READ_SYNTAX",
                    "AFTER_READ_SYNTAX",
                );
                pendingTerminal.assertNoWrappedRows();
                pendingTerminal.assertRowsFitWidth();
            } finally {
                stopCounting();
            }
        },
    );

    it("interprets apply_patch streaming, shrinking, rewriting, and completion without stale cells", async () => {
        await extension?.startAssistantToolCall("apply_patch", "call-xterm-stream");
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

    it("shows the deletion result instead of a stale preflight after another write", async () => {
        const pendingTerminal = new VirtualTerminal(100, 12);
        const activeTui = createTui(pendingTerminal);
        const filePath = "sample.txt";
        const absolutePath = join(cwd, filePath);
        const toolCallId = "changed-delete";
        const tool = new ToolExecutionComponent(
            "Delete",
            toolCallId,
            { path: filePath },
            undefined,
            undefined,
            activeTui,
            cwd,
        );
        const installedExtension = extension;
        if (installedExtension === undefined) throw new Error("extension must be installed");

        writeFileSync(absolutePath, "a\n");
        await installedExtension.emitToolCall(
            { type: "tool_call", toolName: "Delete", toolCallId, input: { path: filePath } },
            cwd,
        );
        writeFileSync(absolutePath, "b\n");
        unlinkSync(absolutePath);

        tool.setArgsComplete();
        tool.updateResult({
            content: [{ type: "text", text: "Successfully deleted sample.txt" }],
            details: { diff: "sample.txt\n-1 b\n" },
            isError: false,
        });
        activeTui.addChild(tool);
        terminal = pendingTerminal;
        tui = activeTui;
        activeTui.start();
        await pendingTerminal.settle();

        expect(pendingTerminal.screenText()).toContain("Deleted sample.txt (-1)");
        expect(
            pendingTerminal.rowsMatching(/\s-/u).map((row) => row.text.trim().slice(-1)),
        ).toEqual(["b"]);
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

    it("presents codemode and direct MCP calls through Pi's real transcript renderer across resizes", async () => {
        const pendingTerminal = new VirtualTerminal(100, 28);
        const activeTui = createTui(pendingTerminal);
        activeTui.setClearOnShrink(true);
        const code = new ToolExecutionComponent(
            "codemode",
            "call-xterm-codemode",
            {
                code: "const pages = await tools.mcp__docs__search({query: 'release'});\ntext(pages);",
            },
            undefined,
            undefined,
            activeTui,
            cwd,
        );
        code.setArgsComplete();
        code.updateResult({
            content: [
                { type: "text", text: "Script completed\nWall time 0.02 seconds\nOutput:\n" },
                { type: "text", text: '{"output":"Two pages\\nMore pages"}' },
            ],
            details: {
                calls: [
                    {
                        id: "call-xterm-codemode/0",
                        name: "mcp__docs__search",
                        args: '{"query":"release"}',
                        status: "ok",
                        durationMs: 20,
                    },
                ],
            },
            isError: false,
        });
        const mcp = new ToolExecutionComponent(
            "mcp__docs__search",
            "call-xterm-mcp",
            { query: "release" },
            undefined,
            undefined,
            activeTui,
            cwd,
        );
        mcp.setArgsComplete();
        mcp.updateResult({ content: [{ type: "text", text: "Found pages" }], isError: false });
        activeTui.addChild(new LinesComponent(["BEFORE_PI_TOOLS"]));
        activeTui.addChild(code);
        activeTui.addChild(mcp);
        activeTui.addChild(new LinesComponent(["AFTER_PI_TOOLS"]));
        terminal = pendingTerminal;
        tui = activeTui;
        activeTui.start();
        await pendingTerminal.settle();

        for (const columns of [100, 45, 100]) {
            pendingTerminal.resize(columns, 28);
            await pendingTerminal.settle();
            const screen = pendingTerminal.screenText();
            expect(screen).toContain("Ran code");
            expect(screen).toContain("tools.mcp__docs__search");
            expect(screen).toContain("Two pages");
            expect(screen).toContain("More pages");
            expect(screen).not.toContain("\\nMore pages");
            expect(screen).toContain("MCP docs/search");
            expect(screen).toContain("Found pages");
            expect(screen).not.toContain("Script completed");
            expect(screen).not.toContain('"code":');
            expect(pendingTerminal.countOccurrences("BEFORE_PI_TOOLS")).toBe(1);
            expect(pendingTerminal.countOccurrences("AFTER_PI_TOOLS")).toBe(1);
            pendingTerminal.assertNoWrappedRows();
            pendingTerminal.assertRowsFitWidth();
        }
    });

    it.runIf(mode === "fullscreen")(
        "toggles codemode code and response independently by click",
        async () => {
            const pendingTerminal = new VirtualTerminal(100, 55);
            const activeTui = createTui(pendingTerminal);
            const script = [
                "const step0 = 0;",
                ...Array.from(
                    { length: 10 },
                    (_, index) => `const step${index + 1} = ${index + 1};`,
                ),
                "finalCodeMarker();",
            ].join("\n");
            const output = Array.from({ length: 10 }, (_, index) => `result line ${index + 1}`);
            output.push("last-result-line");
            const code = new ToolExecutionComponent(
                "codemode",
                "call-xterm-independent",
                { code: script },
                undefined,
                undefined,
                activeTui,
                cwd,
            );
            code.setArgsComplete();
            code.updateResult({
                content: [
                    { type: "text", text: "Script completed\nWall time 0.02 seconds\nOutput:\n" },
                    { type: "text", text: JSON.stringify({ output: output.join("\n") }) },
                ],
                isError: false,
            });

            activeTui.addChild(new LinesComponent(["BEFORE_CODEMODE"]));
            activeTui.addChild(code);
            activeTui.addChild(new LinesComponent(["AFTER_CODEMODE"]));
            terminal = pendingTerminal;
            tui = activeTui;
            activeTui.start();
            await pendingTerminal.settle();

            const click = async (text: string): Promise<void> => {
                const row = pendingTerminal.requireRowContaining(text);
                const column = row.text.indexOf(text) + 1;
                pendingTerminal.sendInput(`\u001b[<0;${column};${row.index + 1}M`);
                pendingTerminal.sendInput(`\u001b[<0;${column};${row.index + 1}m`);
                await pendingTerminal.settle();
            };

            expect(pendingTerminal.screenText()).not.toContain("finalCodeMarker");
            expect(pendingTerminal.screenText()).not.toContain("last-result-line");
            await click("const step0");
            expect(pendingTerminal.screenText()).toContain("finalCodeMarker");
            expect(pendingTerminal.screenText()).not.toContain("last-result-line");
            await click("output:");
            expect(pendingTerminal.screenText()).toContain("finalCodeMarker");
            expect(pendingTerminal.screenText()).toContain("last-result-line");
            await click("const step0");
            expect(pendingTerminal.screenText()).not.toContain("finalCodeMarker");
            expect(pendingTerminal.screenText()).toContain("last-result-line");

            code.setExpanded(true);
            activeTui.requestRender();
            await pendingTerminal.settle();
            expect(pendingTerminal.screenText()).toContain("finalCodeMarker");
            expect(pendingTerminal.screenText()).toContain("last-result-line");
            code.setExpanded(false);
            activeTui.requestRender();
            await pendingTerminal.settle();
            expect(pendingTerminal.screenText()).not.toContain("finalCodeMarker");
            expect(pendingTerminal.screenText()).not.toContain("last-result-line");
            expect(pendingTerminal.countOccurrences("BEFORE_CODEMODE")).toBe(1);
            expect(pendingTerminal.countOccurrences("AFTER_CODEMODE")).toBe(1);
            pendingTerminal.assertNoWrappedRows();
            pendingTerminal.assertRowsFitWidth();
        },
    );

    const structuredArgs = {
        first: "FIRST_ARGUMENT",
        field0: "value0",
        field1: "value1",
        field2: "value2",
        field3: "value3",
        field4: "value4",
        field5: "value5",
        field6: "value6",
        field7: "value7",
        field8: "value8",
        field9: "value9",
    };

    for (const scenario of [
        {
            name: "bash",
            args: {
                command: Array.from({ length: 12 }, (_, index) => `echo step${index + 1}`)
                    .concat("echo BASH_CALL_TAIL")
                    .join("\n"),
            },
            callStart: "$ echo step1",
            callTail: "BASH_CALL_TAIL",
        },
        {
            name: "mcp__docs__review",
            args: { ...structuredArgs, last: "MCP_CALL_TAIL" },
            callStart: "MCP docs/review",
            callTail: "MCP_CALL_TAIL",
        },
        {
            name: "unhandled_report",
            args: { ...structuredArgs, last: "GENERIC_CALL_TAIL" },
            callStart: "Called unhandled_report",
            callTail: "GENERIC_CALL_TAIL",
        },
    ]) {
        it.runIf(mode === "fullscreen")(
            `expands ${scenario.name} call and result independently on click`,
            async () => {
                const pendingTerminal = new VirtualTerminal(100, 55);
                const activeTui = createTui(pendingTerminal);
                const tool = new ToolExecutionComponent(
                    scenario.name,
                    `call-xterm-${scenario.name}`,
                    scenario.args,
                    undefined,
                    undefined,
                    activeTui,
                    cwd,
                );
                tool.setArgsComplete();
                const output = Array.from({ length: 12 }, (_, index) =>
                    index === 6
                        ? "RESULT_MIDDLE_MARKER"
                        : `output row ${String(index + 1).padStart(2, "0")}`,
                ).join("\n");
                tool.updateResult({ content: [{ type: "text", text: output }], isError: false });
                activeTui.addChild(tool);
                terminal = pendingTerminal;
                tui = activeTui;
                activeTui.start();
                await pendingTerminal.settle();

                const click = async (text: string): Promise<void> => {
                    const row = pendingTerminal.requireRowContaining(text);
                    const column = row.text.indexOf(text) + 1;
                    pendingTerminal.sendInput(`\u001b[<0;${column};${row.index + 1}M`);
                    pendingTerminal.sendInput(`\u001b[<0;${column};${row.index + 1}m`);
                    await pendingTerminal.settle();
                };

                expect(pendingTerminal.screenText()).not.toContain(scenario.callTail);
                expect(pendingTerminal.screenText()).not.toContain("RESULT_MIDDLE_MARKER");
                await click(scenario.callStart);
                expect(pendingTerminal.screenText()).toContain(scenario.callTail);
                expect(pendingTerminal.screenText()).not.toContain("RESULT_MIDDLE_MARKER");
                await click("output row 01");
                expect(pendingTerminal.screenText()).toContain(scenario.callTail);
                expect(pendingTerminal.screenText()).toContain("RESULT_MIDDLE_MARKER");
                await click(scenario.callStart);
                expect(pendingTerminal.screenText()).not.toContain(scenario.callTail);
                expect(pendingTerminal.screenText()).toContain("RESULT_MIDDLE_MARKER");

                tool.setExpanded(true);
                activeTui.requestRender();
                await pendingTerminal.settle();
                expect(pendingTerminal.screenText()).toContain(scenario.callTail);
                expect(pendingTerminal.screenText()).toContain("RESULT_MIDDLE_MARKER");
                tool.setExpanded(false);
                activeTui.requestRender();
                await pendingTerminal.settle();
                expect(pendingTerminal.screenText()).not.toContain(scenario.callTail);
                expect(pendingTerminal.screenText()).not.toContain("RESULT_MIDDLE_MARKER");
                pendingTerminal.assertRowsFitWidth();
            },
        );
    }

    it.runIf(mode === "fullscreen")(
        "expands question choices and answer context independently",
        async () => {
            const pendingTerminal = new VirtualTerminal(100, 35);
            const activeTui = createTui(pendingTerminal);

            const questions = [
                {
                    header: "Alpha",
                    question: "Where should Alpha go?",
                    options: [
                        { label: "Near", description: "ALPHA_OPTION_DETAIL" },
                        { label: "Far", description: "Another option" },
                    ],
                },
                {
                    header: "Beta",
                    question: "Where should Beta go?",
                    options: [
                        { label: "Here", description: "BETA_OPTION_DETAIL" },
                        { label: "There", description: "Another option" },
                    ],
                },
            ];

            const tool = new ToolExecutionComponent(
                "ask_user_question",
                "call-xterm-questions",
                { questions },
                undefined,
                undefined,
                activeTui,
                cwd,
            );
            tool.setArgsComplete();
            tool.updateResult({
                content: [
                    {
                        type: "text",
                        text: '"Where should Alpha go?" = "Near"\n"Where should Beta go?" = "Here"',
                    },
                ],
                isError: false,
            });
            activeTui.addChild(tool);
            terminal = pendingTerminal;
            tui = activeTui;
            activeTui.start();
            await pendingTerminal.settle();

            const click = async (text: string): Promise<void> => {
                const row = pendingTerminal.requireRowContaining(text);
                const column = row.text.indexOf(text) + 1;
                pendingTerminal.sendInput(`\u001b[<0;${column};${row.index + 1}M`);
                pendingTerminal.sendInput(`\u001b[<0;${column};${row.index + 1}m`);
                await pendingTerminal.settle();
            };

            expect(pendingTerminal.screenText()).not.toContain("ALPHA_OPTION_DETAIL");
            expect(pendingTerminal.countOccurrences("Where should Alpha go?")).toBe(1);
            await click("Choose one: Near");
            expect(pendingTerminal.screenText()).toContain("ALPHA_OPTION_DETAIL");
            expect(pendingTerminal.countOccurrences("Where should Alpha go?")).toBe(1);
            await click("→ Near");
            expect(pendingTerminal.screenText()).toContain("ALPHA_OPTION_DETAIL");
            expect(pendingTerminal.countOccurrences("Where should Alpha go?")).toBe(2);
        },
    );

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
        expect(pendingTerminal.countOccurrences("BEFORE_SENTINEL")).toBe(1);
        expect(pendingTerminal.countOccurrences("AFTER_SENTINEL")).toBe(1);
        pendingTerminal.assertNoWrappedRows();
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

        pendingTerminal.resize(80, 30);
        await pendingTerminal.settle();
        expect(pendingTerminal.screenText()).not.toContain(" │ ");

        pendingTerminal.resize(180, 30);
        await pendingTerminal.settle();
        expect(pendingTerminal.screenText()).toBe(wide);
    });

    it("keeps settled statement-mode Write colors across real host invalidations", async () => {
        await installExtension({ streaming: { prose: "token", code: "statement" } });
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
        const source = Array.from(
            { length: 220 },
            (_value, index) => `export const value${index} = "retained_${index}";`,
        );
        const pendingTerminal = new VirtualTerminal(100, 30);
        const activeTui = createTui(pendingTerminal);
        const tool = new ToolExecutionComponent(
            "write",
            "statement-write-redraw",
            { path: "src/statements.ts", content: source.join("\n") },
            undefined,
            undefined,
            activeTui,
            cwd,
        );
        tool.setArgsComplete();
        tool.updateResult({ content: [], isError: false });
        activeTui.addChild(tool);
        terminal = pendingTerminal;
        tui = activeTui;
        activeTui.start();

        for (let attempt = 0; attempt < 100; attempt += 1) {
            await settleSyntaxHighlights();
            await pendingTerminal.settle();
            const row = pendingTerminal
                .interpretedRows()
                .find((line) => line.text.includes("value219"));
            if (row !== undefined && codeForegrounds(row, source[219]!).size > 1) break;
        }

        const row = pendingTerminal.requireRowContaining("value219");
        expect(codeForegrounds(row, source[219]!).size).toBeGreaterThan(1);
        const settled = pendingTerminal.interpretedRows();
        for (let redraw = 0; redraw < 4; redraw += 1) {
            tool.invalidate();
            activeTui.requestRender();
            await pendingTerminal.settle(0);
            expect(pendingTerminal.interpretedRows()).toEqual(settled);
            await settleSyntaxHighlights();
            await pendingTerminal.settle();
            expect(pendingTerminal.interpretedRows()).toEqual(settled);
        }
    });

    it.each(["edit", "apply_patch"] as const)(
        "keeps large %s text-diff syntax colors through real tool-row redraws",
        async (toolName) => {
            await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
            const source = Array.from(
                { length: 180 },
                (_value, index) =>
                    `const value${index} = formatValue("syntax_${index}", ${index});`,
            );
            expect(Buffer.byteLength(source.join("\n"))).toBeGreaterThan(8 * 1024);
            const patch = [
                "*** Begin Patch",
                "*** Add File: src/colors.ts",
                ...source.map((line) => `+${line}`),
                "*** End Patch",
            ].join("\n");
            const pendingTerminal = new VirtualTerminal(100, 200);
            const activeTui = createTui(pendingTerminal);
            let definition;
            if (toolName === "apply_patch") definition = applyPatchOwnerToolDefinition;

            const tool = new ToolExecutionComponent(
                toolName,
                `call-xterm-retained-colors-${toolName}`,
                { path: "src/colors.ts", patch },
                undefined,
                definition,
                activeTui,
                cwd,
            );
            const result = () => ({
                content: [],
                details: {
                    diff: source.map((line, index) => `+${index + 1} ${line}`).join("\n"),
                    // Semantic owner rows without a usable Pierre patch take the text path.
                    inputPatch: patch,
                    patch: "",
                },
                isError: false,
            });
            tool.setExpanded(true);
            tool.setArgsComplete();
            tool.updateResult(result());
            activeTui.addChild(tool);
            terminal = pendingTerminal;
            tui = activeTui;
            activeTui.start();
            await pendingTerminal.settle();
            await settleSyntaxHighlights();
            await pendingTerminal.settle();
            const row = pendingTerminal.requireRowContaining("const value179");
            expect(codeForegrounds(row, source[179]!).size).toBeGreaterThan(1);
            const settled = pendingTerminal.interpretedRows();

            for (let redraw = 0; redraw < 4; redraw += 1) {
                tool.updateResult(result());
                activeTui.requestRender();
                await pendingTerminal.settle(0);
                expect(pendingTerminal.interpretedRows()).toEqual(settled);
                await settleSyntaxHighlights();
                await pendingTerminal.settle();
                expect(pendingTerminal.interpretedRows()).toEqual(settled);
            }

            pendingTerminal.assertNoWrappedRows();
        },
    );

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
        await installExtension({ mutations: { defaultView: "preview" } });
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
        const assertAdjacentTranscript = (): number => {
            pendingTerminal.assertUniqueTranscriptMarkers(
                "Patched src/expanded.ts",
                "BEFORE_TRANSCRIPT",
                "AFTER_TRANSCRIPT",
            );
            const before = pendingTerminal.requireRowContaining("BEFORE_TRANSCRIPT");
            const header = pendingTerminal.requireRowContaining("Patched src/expanded.ts");
            const after = pendingTerminal.requireRowContaining("AFTER_TRANSCRIPT");
            expect(before.index).toBeLessThan(header.index);
            expect(header.index).toBeLessThan(after.index);
            pendingTerminal.assertNeutralRange(before);
            pendingTerminal.assertNeutralRange(after);

            return after.index;
        };

        const collapsed = pendingTerminal.screenText();
        const collapsedAfter = assertAdjacentTranscript();
        expect(collapsed).not.toContain("line5");
        expect(collapsed).toContain("lines");

        tool.setExpanded(true);
        activeTui.requestRender();
        await pendingTerminal.settle();
        const expanded = pendingTerminal.screenText();
        expect(expanded).toContain("line5");
        expect(expanded).toContain("line9");
        const expandedAfter = assertAdjacentTranscript();
        expect(expandedAfter).toBeGreaterThan(collapsedAfter);

        tool.setExpanded(false);
        activeTui.requestRender();
        await pendingTerminal.settle();
        expect(pendingTerminal.screenText()).toBe(collapsed);
        expect(assertAdjacentTranscript()).toBe(collapsedAfter);
        const clearedRows = pendingTerminal
            .interpretedRows()
            .filter((row) => row.index > collapsedAfter && row.index <= expandedAfter);
        expect(clearedRows.length).toBe(expandedAfter - collapsedAfter);

        for (const row of clearedRows) {
            expect(row.text.trim()).toBe("");
            pendingTerminal.assertNeutralRange(row);
        }
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
        running.terminal.assertNoWrappedRows();
        running.terminal.assertRowsFitWidth();
    });
});
