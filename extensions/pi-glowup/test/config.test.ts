import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_LOOK_CONFIG_JSON,
  codexLookConfigJsonSchema,
  getCodexLookGlobalConfigPath,
  getCodexLookGlobalConfigSchemaPath,
  getCodexLookProjectConfigPath,
  parseCodexLookConfig,
  readCodexLookConfig,
} from "../src/config.ts";

describe("codex look config", () => {
  it("parses optional config with safe defaults", () => {
    const config = parseCodexLookConfig({});

    expect(config.preserveTools).toEqual([]);
    expect(config.scriptFormatters.size).toBe(0);
    expect(config.scriptHeaderLayout).toBe("auto");
    expect(config.syntaxPreloadOnStartup).toBe(false);
    expect(config.patches).toEqual({
      assistantSeparator: true,
      workingWidgetSpacing: false,
      autocompleteCleanup: true,
      markdownSyntax: true,
      thirdPartyToolRenderers: true,
    });
  });

  it("ignores invalid config shapes with a safe warning", () => {
    const reportedWarnings: string[] = [];

    const config = parseCodexLookConfig(
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
    expect(config.scriptFormatters.size).toBe(0);
    expect(config.scriptHeaderLayout).toBe("auto");
    expect(config.syntaxPreloadOnStartup).toBe(false);
    expect(config.patches.workingWidgetSpacing).toBe(false);
    expect(reportedWarnings).toEqual([
      expect.stringContaining("[pi-codex-look] Ignoring invalid test config:"),
    ]);
    expect(reportedWarnings[0]).not.toContain("unknownSetting");
  });

  it("scaffolds missing global config and schema files", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-codex-look-config-"));
    const agentDir = join(root, "agent");

    const config = readCodexLookConfig({ agentDir });

    expect(config.preserveTools).toEqual([]);
    expect(config.scriptFormatters.size).toBe(0);
    expect(config.scriptHeaderLayout).toBe("auto");
    expect(config.syntaxPreloadOnStartup).toBe(false);
    expect(config.patches.workingWidgetSpacing).toBe(false);
    expect(JSON.parse(readFileSync(getCodexLookGlobalConfigPath(agentDir), "utf8"))).toEqual(
      DEFAULT_CODEX_LOOK_CONFIG_JSON,
    );
    expect(JSON.parse(readFileSync(getCodexLookGlobalConfigSchemaPath(agentDir), "utf8"))).toEqual(
      codexLookConfigJsonSchema(),
    );
  });

  it("does not overwrite malformed existing global config", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-codex-look-config-"));
    const agentDir = join(root, "agent");
    const configPath = getCodexLookGlobalConfigPath(agentDir);
    const reportedWarnings: string[] = [];
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(configPath, "{not json");

    const config = readCodexLookConfig({
      agentDir,
      reportWarning: (message) => reportedWarnings.push(message),
    });

    expect(config.preserveTools).toEqual([]);
    expect(config.syntaxPreloadOnStartup).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe("{not json");
    expect(reportedWarnings).toEqual([
      expect.stringContaining(`[pi-codex-look] Failed to read ${configPath}:`),
    ]);
  });

  it("refreshes stale global schema without rewriting user config", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-codex-look-config-"));
    const agentDir = join(root, "agent");
    const configPath = getCodexLookGlobalConfigPath(agentDir);
    const schemaPath = getCodexLookGlobalConfigSchemaPath(agentDir);
    const reportedWarnings: string[] = [];
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(configPath, "{not json");
    writeFileSync(schemaPath, "{}\n");

    const config = readCodexLookConfig({
      agentDir,
      reportWarning: (message) => reportedWarnings.push(message),
    });

    expect(config.preserveTools).toEqual([]);
    expect(config.patches.thirdPartyToolRenderers).toBe(true);
    expect(readFileSync(configPath, "utf8")).toBe("{not json");
    expect(JSON.parse(readFileSync(schemaPath, "utf8"))).toEqual(codexLookConfigJsonSchema());
    expect(reportedWarnings).toEqual([
      expect.stringContaining(`[pi-codex-look] Failed to read ${configPath}:`),
    ]);
  });

  it("keeps checked-in config schema aligned with TypeBox source", () => {
    expect(JSON.parse(readFileSync("config.schema.json", "utf8"))).toEqual(
      codexLookConfigJsonSchema(),
    );
  });

  it("merges project config over global config", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-codex-look-config-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const globalConfigPath = getCodexLookGlobalConfigPath(agentDir);
    const projectConfigPath = getCodexLookProjectConfigPath(cwd);
    mkdirSync(join(globalConfigPath, ".."), { recursive: true });
    mkdirSync(join(projectConfigPath, ".."), { recursive: true });
    writeFileSync(
      globalConfigPath,
      JSON.stringify({
        $schema: "./config.schema.json",
        preserveTools: ["mcp"],
        syntax: { preloadOnStartup: true },
        patches: { workingWidgetSpacing: true },
        scriptPreview: { headerLayout: "block" },
      }),
    );
    writeFileSync(
      projectConfigPath,
      JSON.stringify({
        patches: { workingWidgetSpacing: false, markdownSyntax: false },
        scriptPreview: { formatters: { python: ["black", "-"] } },
      }),
    );

    const config = readCodexLookConfig({ agentDir, cwd });

    expect(config.preserveTools).toEqual(["mcp"]);
    expect(config.scriptHeaderLayout).toBe("block");
    expect(config.scriptFormatters.get("python")).toEqual(["black", "-"]);
    expect(config.syntaxPreloadOnStartup).toBe(true);
    expect(config.patches.workingWidgetSpacing).toBe(false);
    expect(config.patches.markdownSyntax).toBe(false);
    expect(config.patches.thirdPartyToolRenderers).toBe(true);
  });
});
