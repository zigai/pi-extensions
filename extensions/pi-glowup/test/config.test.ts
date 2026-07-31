import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    DEFAULT_GLOWUP_CONFIG_JSON,
    glowupConfigJsonSchema,
    getGlowupGlobalConfigPath,
    getGlowupGlobalConfigSchemaPath,
    getGlowupProjectConfigPath,
    parseGlowupConfig,
    readGlowupConfig,
} from "../src/config/config.ts";

describe("glowup config", () => {
    it("parses optional config with safe defaults", () => {
        const config = parseGlowupConfig({});

        expect(config.preserveTools).toEqual([]);
        expect(config.mutations).toEqual({
            defaultView: "full",
            previewLines: 6,
            limits: {
                maxDiffBytes: 512 * 1024,
                maxDiffLines: 5_000,
                maxWritePreviewBytes: 64 * 1024,
                maxDeletePreimageBytes: 256 * 1024,
            },
        });
        expect(config.appearance).toEqual({
            diffBackgroundStyle: "two-tone",
            diffLineNumberStyle: "dual",
            narrowDiffLayout: "paired",
            sideBySideLayout: "content-aware",
            addedRowBackground: "#213A2B",
            deletedRowBackground: "#4A221D",
            addedContentBackground: "#0D5728",
            deletedContentBackground: "#762925",
            instructionPathColor: null,
            dimUnchangedDiffText: false,
        });
        expect(config.debugLog).toEqual({
            enabled: false,
            path: "debug.log",
            maxBytes: null,
            memorySampleIntervalMs: 10_000,
        });
        expect(config.scriptFormatters.size).toBe(0);
        expect(config.scriptHeaderLayout).toBe("auto");
        expect(config.scriptMaxCodePreviewLines).toBe(8);
        expect(config.toolCallIndicator).toEqual({ symbol: "•", bold: true });
        expect(config.toolLabels.mode).toBe("static");
        expect(config.writePreview).toEqual({ movingViewport: true });
        expect(config.syntax).toEqual({
            preloadLanguages: ["markdown", "bash", "python", "typescript", "javascript", "json"],
            bracketPairColoring: true,
            projectLanguageDetection: { enabled: true },
        });
        expect(config.patches).toEqual({
            assistantSeparator: true,
            workingWidgetSpacing: false,
            autocompleteCleanup: true,
            markdownSyntax: true,
            thirdPartyToolRenderers: true,
        });
    });

    it("parses user-configured rendering colors", () => {
        const config = parseGlowupConfig({
            appearance: {
                diffBackgroundStyle: "full-row",
                diffLineNumberStyle: "single",
                narrowDiffLayout: "traditional",
                sideBySideLayout: "fixed",
                addedRowBackground: "#123456",
                deletedRowBackground: "#654321",
                addedContentBackground: "#234567",
                deletedContentBackground: "#765432",
                instructionPathColor: "#AABBCC",
                dimUnchangedDiffText: true,
            },
        });

        expect(config.appearance).toEqual({
            diffBackgroundStyle: "full-row",
            diffLineNumberStyle: "single",
            narrowDiffLayout: "traditional",
            sideBySideLayout: "fixed",
            addedRowBackground: "#123456",
            deletedRowBackground: "#654321",
            addedContentBackground: "#234567",
            deletedContentBackground: "#765432",
            instructionPathColor: "#AABBCC",
            dimUnchangedDiffText: true,
        });
    });

    it("keeps the previous compact diff appearance selectable", () => {
        const config = parseGlowupConfig({
            appearance: {
                diffBackgroundStyle: "changed-spans",
                diffLineNumberStyle: "single",
            },
        });

        expect(config.appearance.diffBackgroundStyle).toBe("changed-spans");
        expect(config.appearance.diffLineNumberStyle).toBe("single");
    });

    it("keeps the previous bounded mutation view selectable", () => {
        const config = parseGlowupConfig({
            mutations: {
                defaultView: "preview",
                previewLines: 12,
                limits: {
                    maxDiffBytes: null,
                    maxDiffLines: 20_000,
                    maxWritePreviewBytes: null,
                    maxDeletePreimageBytes: 1024,
                },
            },
        });

        expect(config.mutations).toEqual({
            defaultView: "preview",
            previewLines: 12,
            limits: {
                maxDiffBytes: null,
                maxDiffLines: 20_000,
                maxWritePreviewBytes: null,
                maxDeletePreimageBytes: 1024,
            },
        });
    });

    it("allows diff backgrounds to inherit Pi explicitly", () => {
        const config = parseGlowupConfig({
            appearance: {
                addedRowBackground: null,
                deletedRowBackground: null,
                addedContentBackground: null,
                deletedContentBackground: null,
            },
        });

        expect(config.appearance).toMatchObject({
            addedRowBackground: null,
            deletedRowBackground: null,
            addedContentBackground: null,
            deletedContentBackground: null,
        });
    });

    it("parses user-configured tool call indicators", () => {
        const config = parseGlowupConfig({
            toolCallIndicator: { symbol: "▸", bold: false },
        });

        expect(config.toolCallIndicator).toEqual({ symbol: "▸", bold: false });
    });

    it("allows bracket pair coloring to be disabled", () => {
        const config = parseGlowupConfig({
            syntax: { bracketPairColoring: false },
        });

        expect(config.syntax.bracketPairColoring).toBe(false);
    });

    it("ignores invalid config shapes with a safe warning", () => {
        const reportedWarnings: string[] = [];

        const config = parseGlowupConfig(
            {
                preserveTools: ["mcp"],
                unknownSetting: true,
            },
            {
                source: "test config",
                reportWarning: (message) => reportedWarnings.push(message),
            },
        );

        expect(config.preserveTools).toEqual([]);
        expect(config.debugLog.enabled).toBe(false);
        expect(config.scriptFormatters.size).toBe(0);
        expect(config.scriptHeaderLayout).toBe("auto");
        expect(config.scriptMaxCodePreviewLines).toBe(8);
        expect(config.toolCallIndicator).toEqual({ symbol: "•", bold: true });
        expect(config.toolLabels.mode).toBe("static");
        expect(config.writePreview.movingViewport).toBe(true);
        expect(config.syntax.preloadLanguages).toEqual([
            "markdown",
            "bash",
            "python",
            "typescript",
            "javascript",
            "json",
        ]);
        expect(config.syntax.projectLanguageDetection.enabled).toBe(true);
        expect(config.patches.workingWidgetSpacing).toBe(false);
        expect(reportedWarnings).toEqual([
            expect.stringContaining("[pi-glowup] Ignoring invalid test config:"),
        ]);
        expect(reportedWarnings[0]).not.toContain("unknownSetting");
    });

    it("scaffolds missing global config and schema files", () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-config-"));
        const agentDir = join(root, "agent");

        const config = readGlowupConfig({ agentDir });

        expect(config.preserveTools).toEqual([]);
        expect(config.debugLog.path).toBe("debug.log");
        expect(config.scriptFormatters.size).toBe(0);
        expect(config.scriptHeaderLayout).toBe("auto");
        expect(config.scriptMaxCodePreviewLines).toBe(8);
        expect(config.toolCallIndicator).toEqual({ symbol: "•", bold: true });
        expect(config.toolLabels.mode).toBe("static");
        expect(config.writePreview.movingViewport).toBe(true);
        expect(config.syntax.projectLanguageDetection.enabled).toBe(true);
        expect(config.patches.workingWidgetSpacing).toBe(false);
        expect(JSON.parse(readFileSync(getGlowupGlobalConfigPath(agentDir), "utf8"))).toEqual(
            DEFAULT_GLOWUP_CONFIG_JSON,
        );
        expect(JSON.parse(readFileSync(getGlowupGlobalConfigSchemaPath(agentDir), "utf8"))).toEqual(
            glowupConfigJsonSchema(),
        );
    });

    it("does not overwrite malformed existing global config", () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-config-"));
        const agentDir = join(root, "agent");
        const configPath = getGlowupGlobalConfigPath(agentDir);
        const reportedWarnings: string[] = [];
        mkdirSync(join(configPath, ".."), { recursive: true });
        writeFileSync(configPath, "{not json");

        const config = readGlowupConfig({
            agentDir,
            reportWarning: (message) => reportedWarnings.push(message),
        });

        expect(config.preserveTools).toEqual([]);
        expect(config.debugLog.enabled).toBe(false);
        expect(config.toolCallIndicator).toEqual({ symbol: "•", bold: true });
        expect(config.toolLabels.mode).toBe("static");
        expect(config.writePreview.movingViewport).toBe(true);
        expect(config.syntax.preloadLanguages).toEqual([
            "markdown",
            "bash",
            "python",
            "typescript",
            "javascript",
            "json",
        ]);
        expect(config.scriptMaxCodePreviewLines).toBe(8);
        expect(readFileSync(configPath, "utf8")).toBe("{not json");
        expect(reportedWarnings).toEqual([
            expect.stringContaining(`[pi-glowup] Failed to read ${configPath}:`),
        ]);
    });

    it("refreshes stale global schema without rewriting user config", () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-config-"));
        const agentDir = join(root, "agent");
        const configPath = getGlowupGlobalConfigPath(agentDir);
        const schemaPath = getGlowupGlobalConfigSchemaPath(agentDir);
        const reportedWarnings: string[] = [];
        mkdirSync(join(configPath, ".."), { recursive: true });
        writeFileSync(configPath, "{not json");
        writeFileSync(schemaPath, "{}\n");

        const config = readGlowupConfig({
            agentDir,
            reportWarning: (message) => reportedWarnings.push(message),
        });

        expect(config.preserveTools).toEqual([]);
        expect(config.debugLog.memorySampleIntervalMs).toBe(10_000);
        expect(config.toolCallIndicator).toEqual({ symbol: "•", bold: true });
        expect(config.toolLabels.mode).toBe("static");
        expect(config.writePreview.movingViewport).toBe(true);
        expect(config.syntax.projectLanguageDetection.enabled).toBe(true);
        expect(config.patches.thirdPartyToolRenderers).toBe(true);
        expect(readFileSync(configPath, "utf8")).toBe("{not json");
        expect(JSON.parse(readFileSync(schemaPath, "utf8"))).toEqual(glowupConfigJsonSchema());
        expect(reportedWarnings).toEqual([
            expect.stringContaining(`[pi-glowup] Failed to read ${configPath}:`),
        ]);
    });

    it("keeps checked-in config schema aligned with TypeBox source", () => {
        expect(JSON.parse(readFileSync("config.schema.json", "utf8"))).toEqual(
            glowupConfigJsonSchema(),
        );
    });

    it.each(["README.md", "docs/configuration.md"])(
        "keeps the full default config synchronized in %s",
        (filePath) => {
            const markdown = readFileSync(filePath, "utf8");
            const match = /```json\n(?<json>\{[\s\S]*?\})\n```/u.exec(markdown);
            const json = match?.groups?.json;

            expect(json).toBeDefined();
            expect(JSON.parse(json ?? "{}")).toEqual(DEFAULT_GLOWUP_CONFIG_JSON);
        },
    );

    it("keeps the checked-in config schema synchronized", () => {
        expect(JSON.parse(readFileSync("config.schema.json", "utf8"))).toEqual(
            glowupConfigJsonSchema(),
        );
    });

    it("ignores project config unless trusted project config is included", () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-config-"));
        const agentDir = join(root, "agent");
        const cwd = join(root, "project");
        const globalConfigPath = getGlowupGlobalConfigPath(agentDir);
        const projectConfigPath = getGlowupProjectConfigPath(cwd);
        mkdirSync(join(globalConfigPath, ".."), { recursive: true });
        mkdirSync(join(projectConfigPath, ".."), { recursive: true });
        writeFileSync(
            globalConfigPath,
            JSON.stringify({
                $schema: "./config.schema.json",
                preserveTools: ["mcp"],
                mutations: {
                    defaultView: "preview",
                    limits: { maxDiffLines: 1_000 },
                },
                debugLog: { enabled: false, memorySampleIntervalMs: 0 },
                toolCallIndicator: { symbol: "·", bold: false },
                toolLabels: { mode: "lifecycle" },
                writePreview: { movingViewport: false },
                syntax: {
                    preloadLanguages: ["go"],
                    projectLanguageDetection: { enabled: false },
                },
                patches: { workingWidgetSpacing: true },
                scriptPreview: { headerLayout: "block", maxCodePreviewLines: 12 },
            }),
        );
        writeFileSync(
            projectConfigPath,
            JSON.stringify({
                mutations: {
                    defaultView: "full",
                    limits: { maxDiffBytes: null },
                },
                toolLabels: { mode: "static" },
                toolCallIndicator: { symbol: "▸", bold: true },
                writePreview: { movingViewport: true },
                debugLog: { enabled: true, path: "project-debug.log" },
                syntax: {
                    preloadLanguages: ["typescript"],
                    projectLanguageDetection: { enabled: true },
                },
                patches: { workingWidgetSpacing: false, markdownSyntax: false },
                scriptPreview: { maxCodePreviewLines: 4, formatters: { python: ["black", "-"] } },
            }),
        );

        const config = readGlowupConfig({ agentDir, cwd });

        expect(config.preserveTools).toEqual(["mcp"]);
        expect(config.mutations).toMatchObject({
            defaultView: "preview",
            limits: { maxDiffBytes: 512 * 1024, maxDiffLines: 1_000 },
        });
        expect(config.debugLog).toEqual({
            enabled: false,
            path: "debug.log",
            maxBytes: null,
            memorySampleIntervalMs: 0,
        });
        expect(config.scriptHeaderLayout).toBe("block");
        expect(config.scriptMaxCodePreviewLines).toBe(12);
        expect(config.scriptFormatters.get("python")).toBeUndefined();
        expect(config.toolCallIndicator).toEqual({ symbol: "·", bold: false });
        expect(config.toolLabels.mode).toBe("lifecycle");
        expect(config.writePreview.movingViewport).toBe(false);
        expect(config.syntax.preloadLanguages).toEqual(["go"]);
        expect(config.syntax.projectLanguageDetection.enabled).toBe(false);
        expect(config.patches.workingWidgetSpacing).toBe(true);
        expect(config.patches.markdownSyntax).toBe(true);
        expect(config.patches.thirdPartyToolRenderers).toBe(true);
    });

    it("merges trusted project config over global config", () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-config-"));
        const agentDir = join(root, "agent");
        const cwd = join(root, "project");
        const globalConfigPath = getGlowupGlobalConfigPath(agentDir);
        const projectConfigPath = getGlowupProjectConfigPath(cwd);
        mkdirSync(join(globalConfigPath, ".."), { recursive: true });
        mkdirSync(join(projectConfigPath, ".."), { recursive: true });
        writeFileSync(
            globalConfigPath,
            JSON.stringify({
                $schema: "./config.schema.json",
                preserveTools: ["mcp"],
                mutations: {
                    defaultView: "preview",
                    limits: { maxDiffLines: 1_000 },
                },
                debugLog: { enabled: false, memorySampleIntervalMs: 0 },
                toolCallIndicator: { symbol: "·", bold: false },
                toolLabels: { mode: "lifecycle" },
                writePreview: { movingViewport: false },
                syntax: {
                    preloadLanguages: ["go"],
                    projectLanguageDetection: { enabled: false },
                },
                patches: { workingWidgetSpacing: true },
                scriptPreview: { headerLayout: "block", maxCodePreviewLines: 12 },
            }),
        );
        writeFileSync(
            projectConfigPath,
            JSON.stringify({
                mutations: {
                    defaultView: "full",
                    limits: { maxDiffBytes: null },
                },
                toolLabels: { mode: "static" },
                toolCallIndicator: { bold: true },
                writePreview: { movingViewport: true },
                debugLog: { enabled: true, path: "project-debug.log" },
                syntax: {
                    preloadLanguages: ["typescript"],
                    projectLanguageDetection: { enabled: true },
                },
                patches: { workingWidgetSpacing: false, markdownSyntax: false },
                scriptPreview: { maxCodePreviewLines: 4, formatters: { python: ["black", "-"] } },
            }),
        );

        const config = readGlowupConfig({ agentDir, cwd }, { includeProjectConfig: true });

        expect(config.preserveTools).toEqual(["mcp"]);
        expect(config.mutations).toMatchObject({
            defaultView: "full",
            limits: { maxDiffBytes: null, maxDiffLines: 1_000 },
        });
        expect(config.debugLog).toEqual({
            enabled: true,
            path: "project-debug.log",
            maxBytes: null,
            memorySampleIntervalMs: 0,
        });
        expect(config.scriptHeaderLayout).toBe("block");
        expect(config.scriptMaxCodePreviewLines).toBe(4);
        expect(config.scriptFormatters.get("python")).toEqual(["black", "-"]);
        expect(config.toolCallIndicator).toEqual({ symbol: "·", bold: true });
        expect(config.toolLabels.mode).toBe("static");
        expect(config.writePreview.movingViewport).toBe(true);
        expect(config.syntax.preloadLanguages).toEqual(["typescript"]);
        expect(config.syntax.projectLanguageDetection.enabled).toBe(true);
        expect(config.patches.workingWidgetSpacing).toBe(false);
        expect(config.patches.markdownSyntax).toBe(false);
        expect(config.patches.thirdPartyToolRenderers).toBe(true);
    });
});
