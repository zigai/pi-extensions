import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    DEFAULT_GLOWUP_CONFIG_JSON,
    getGlowupGlobalConfigPath,
    getGlowupGlobalConfigSchemaPath,
    getGlowupProjectConfigPath,
    parseGlowupConfig,
    readGlowupConfig,
} from "../src/config/config.ts";
import { jsonValueParser, type JsonValue } from "../src/json-value.ts";

describe("glowup config", () => {
    const agentDirEnvironmentVariable = "PI_CODING_AGENT_DIR";
    const originalAgentDir = process.env[agentDirEnvironmentVariable];

    afterEach(() => {
        if (originalAgentDir === undefined) {
            delete process.env[agentDirEnvironmentVariable];
        } else {
            process.env[agentDirEnvironmentVariable] = originalAgentDir;
        }
    });

    function useAgentDirectory(agentDir: string): void {
        process.env[agentDirEnvironmentVariable] = agentDir;
    }

    function bundledSchema(): JsonValue {
        const schema = jsonValueParser.parse(
            JSON.parse(readFileSync("config.schema.json", "utf8")),
        );
        if (schema === undefined) throw new Error("bundled config schema must be valid JSON");
        return schema;
    }

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
        expect(config.renderCache).toEqual({
            maxBytes: 64 * 1024 * 1024,
            maxEntries: 10_000,
        });
        expect(config.scriptFormatters.size).toBe(0);
        expect(config.scriptHeaderLayout).toBe("auto");
        expect(config.scriptMaxCodePreviewLines).toBe(8);
        expect(config.scriptShowPrologueOmission).toBe(false);
        expect(config.shellLayout).toBe("auto");
        expect(config.shellOperatorPosition).toBe("trailing");
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

    it("parses user-configured render cache limits", () => {
        const config = parseGlowupConfig({
            renderCache: {
                maxBytes: 32 * 1024 * 1024,
                maxEntries: 2_000,
            },
        });

        expect(config.renderCache).toEqual({
            maxBytes: 32 * 1024 * 1024,
            maxEntries: 2_000,
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

    it("parses script preview display options", () => {
        const config = parseGlowupConfig({
            scriptPreview: {
                showPrologueOmission: true,
                shellLayout: "always",
                shellOperatorPosition: "leading",
            },
        });

        expect(config.scriptShowPrologueOmission).toBe(true);
        expect(config.shellLayout).toBe("always");
        expect(config.shellOperatorPosition).toBe("leading");
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
        useAgentDirectory(agentDir);

        const config = readGlowupConfig();

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
            bundledSchema(),
        );
    });

    it("copies a valid legacy global config into the shared settings location", () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-config-"));
        const agentDir = join(root, "agent");
        useAgentDirectory(agentDir);
        const legacyPath = join(agentDir, "pi-glowup", "config.json");
        const legacyContent = JSON.stringify({
            preserveTools: ["mcp"],
            syntax: { preloadLanguages: ["go"] },
        });
        mkdirSync(join(legacyPath, ".."), { recursive: true });
        writeFileSync(legacyPath, legacyContent);

        const config = readGlowupConfig();

        expect(config.preserveTools).toEqual(["mcp"]);
        expect(config.syntax.preloadLanguages).toEqual(["go"]);
        expect(readFileSync(legacyPath, "utf8")).toBe(legacyContent);
        expect(JSON.parse(readFileSync(getGlowupGlobalConfigPath(agentDir), "utf8"))).toMatchObject(
            {
                $schema: "./schemas/pi-glowup.schema.json",
                preserveTools: ["mcp"],
                syntax: { preloadLanguages: ["go"] },
            },
        );
    });

    it("copies a valid legacy project config only for trusted projects", () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-config-"));
        const agentDir = join(root, "agent");
        const cwd = join(root, "project");
        useAgentDirectory(agentDir);
        const legacyPath = join(cwd, ".pi", "pi-glowup", "config.json");
        mkdirSync(join(legacyPath, ".."), { recursive: true });
        writeFileSync(legacyPath, JSON.stringify({ toolLabels: { mode: "lifecycle" } }));

        const untrustedConfig = readGlowupConfig({ cwd });

        expect(untrustedConfig.toolLabels.mode).toBe("static");
        expect(() => readFileSync(getGlowupProjectConfigPath(cwd), "utf8")).toThrow();

        const trustedConfig = readGlowupConfig({ cwd }, { includeProjectConfig: true });

        expect(trustedConfig.toolLabels.mode).toBe("lifecycle");
        expect(JSON.parse(readFileSync(getGlowupProjectConfigPath(cwd), "utf8"))).toMatchObject({
            $schema: "./schemas/pi-glowup.schema.json",
            toolLabels: { mode: "lifecycle" },
        });
    });

    it("does not overwrite malformed existing global config", () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-config-"));
        const agentDir = join(root, "agent");
        useAgentDirectory(agentDir);
        const configPath = getGlowupGlobalConfigPath(agentDir);
        const reportedWarnings: string[] = [];
        mkdirSync(join(configPath, ".."), { recursive: true });
        writeFileSync(configPath, "{not json");

        const config = readGlowupConfig({
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
            expect.stringContaining("[pi-glowup] global settings contain malformed JSON"),
        ]);
    });

    it("refreshes stale global schema without rewriting user config", () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-config-"));
        const agentDir = join(root, "agent");
        useAgentDirectory(agentDir);
        const configPath = getGlowupGlobalConfigPath(agentDir);
        const schemaPath = getGlowupGlobalConfigSchemaPath(agentDir);
        const reportedWarnings: string[] = [];
        mkdirSync(join(configPath, ".."), { recursive: true });
        mkdirSync(join(schemaPath, ".."), { recursive: true });
        writeFileSync(configPath, "{not json");
        writeFileSync(schemaPath, "{}\n");

        const config = readGlowupConfig({
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
        expect(JSON.parse(readFileSync(schemaPath, "utf8"))).toEqual(bundledSchema());
        expect(reportedWarnings).toEqual([
            expect.stringContaining("[pi-glowup] global settings contain malformed JSON"),
        ]);
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

    it("keeps the long syntax default out of the generated README table", () => {
        const markdown = readFileSync("README.md", "utf8");

        expect(markdown).toContain("| `syntax.preloadLanguages` | string[] | *See JSON below");
        expect(markdown).not.toContain(
            '| `syntax.preloadLanguages` | string[] | `["markdown","bash","python","typescript","javascript","json"]`',
        );
    });

    it("ignores project config unless trusted project config is included", () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-config-"));
        const agentDir = join(root, "agent");
        useAgentDirectory(agentDir);
        const cwd = join(root, "project");
        const globalConfigPath = getGlowupGlobalConfigPath(agentDir);
        const projectConfigPath = getGlowupProjectConfigPath(cwd);
        mkdirSync(join(globalConfigPath, ".."), { recursive: true });
        mkdirSync(join(projectConfigPath, ".."), { recursive: true });
        writeFileSync(
            globalConfigPath,
            JSON.stringify({
                $schema: "./schemas/pi-glowup.schema.json",
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

        const config = readGlowupConfig({ cwd });

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
        useAgentDirectory(agentDir);
        const cwd = join(root, "project");
        const globalConfigPath = getGlowupGlobalConfigPath(agentDir);
        const projectConfigPath = getGlowupProjectConfigPath(cwd);
        mkdirSync(join(globalConfigPath, ".."), { recursive: true });
        mkdirSync(join(projectConfigPath, ".."), { recursive: true });
        writeFileSync(
            globalConfigPath,
            JSON.stringify({
                $schema: "./schemas/pi-glowup.schema.json",
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

        const config = readGlowupConfig({ cwd }, { includeProjectConfig: true });

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
