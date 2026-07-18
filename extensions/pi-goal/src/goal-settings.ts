import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  normalizeActiveGoalToolPolicy,
  validateActiveGoalToolPolicy,
  type ActiveGoalToolPolicy,
} from "./goal-tool-policy.js";

const EXTENSION_ID = "pi-codex-goal";
const CONFIG_BASENAME = "config.json";
const CONFIG_SCHEMA_BASENAME = "config.schema.json";

const CONFIG_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "pi-codex-goal settings",
  type: "object",
  additionalProperties: false,
  properties: {
    $schema: { type: "string" },
    creationPromptPath: {
      description:
        "Absolute path, or path relative to this config file, to the goal-creation prompt template. Null uses the bundled template.",
      type: ["string", "null"],
      minLength: 1,
    },
    disabledToolsWhileGoalActive: {
      description:
        "Registered tool names to disable while a goal is active. Previous tool states are restored when the goal stops.",
      type: "array",
      maxItems: 128,
      items: { type: "string", minLength: 1 },
    },
  },
} as const;

const DEFAULT_CONFIG = {
  $schema: `./${CONFIG_SCHEMA_BASENAME}`,
  creationPromptPath: null,
  disabledToolsWhileGoalActive: [],
} as const;

const CONFIG_KEYS = new Set(["$schema", "creationPromptPath", "disabledToolsWhileGoalActive"]);

type GoalSettingsContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

type ParsedGoalConfig = {
  creationPromptPath?: string | null;
  disabledToolsWhileGoalActive?: readonly string[];
};

type LoadedConfig = {
  config: ParsedGoalConfig;
  configPath: string;
};

export interface GoalSettings {
  creationPromptPath: string | null;
  activeGoalToolPolicy: ActiveGoalToolPolicy;
}

export type GoalSettingsResult =
  | { ok: true; settings: GoalSettings }
  | { ok: false; message: string };

export function getGoalGlobalConfigPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, EXTENSION_ID, CONFIG_BASENAME);
}

export function getGoalGlobalConfigSchemaPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, EXTENSION_ID, CONFIG_SCHEMA_BASENAME);
}

function writeJsonIfMissing(path: string, value: unknown): void {
  if (existsSync(path)) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

/** Create discoverable global settings files without replacing user-owned configuration. */
export function ensureGoalConfigFiles(agentDir: string = getAgentDir()): void {
  const configPath = getGoalGlobalConfigPath(agentDir);
  const schemaPath = getGoalGlobalConfigSchemaPath(agentDir);
  writeJsonIfMissing(configPath, DEFAULT_CONFIG);
  mkdirSync(dirname(schemaPath), { recursive: true });
  const schemaText = `${JSON.stringify(CONFIG_SCHEMA, null, 2)}\n`;
  if (!existsSync(schemaPath) || readFileSync(schemaPath, "utf8") !== schemaText) {
    writeFileSync(schemaPath, schemaText, "utf8");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfig(configPath: string): LoadedConfig | undefined {
  if (!existsSync(configPath)) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error(`Goal settings at ${configPath} must be a JSON object.`);
  }
  const unknownKeys = Object.keys(parsed).filter((key) => !CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `Unknown goal setting${unknownKeys.length === 1 ? "" : "s"} in ${configPath}: ${unknownKeys.join(", ")}.`,
    );
  }
  if (parsed.$schema !== undefined && typeof parsed.$schema !== "string") {
    throw new Error(`$schema in ${configPath} must be a string.`);
  }

  const creationPromptPath = parsed.creationPromptPath;
  if (
    creationPromptPath !== undefined &&
    creationPromptPath !== null &&
    (typeof creationPromptPath !== "string" || creationPromptPath.trim().length === 0)
  ) {
    throw new Error(`creationPromptPath in ${configPath} must be a non-empty string or null.`);
  }

  const disabledTools = parsed.disabledToolsWhileGoalActive;
  if (
    disabledTools !== undefined &&
    (!Array.isArray(disabledTools) || !disabledTools.every((name) => typeof name === "string"))
  ) {
    throw new Error(`disabledToolsWhileGoalActive in ${configPath} must be an array of strings.`);
  }
  const policyError = validateActiveGoalToolPolicy(disabledTools ?? []);
  if (policyError !== null) {
    throw new Error(`${policyError} (${configPath})`);
  }

  return {
    config: {
      ...(creationPromptPath === undefined ? {} : { creationPromptPath }),
      ...(disabledTools === undefined ? {} : { disabledToolsWhileGoalActive: disabledTools }),
    },
    configPath,
  };
}

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

function resolvePromptPath(config: LoadedConfig | undefined): string | null {
  if (config === undefined) {
    return null;
  }
  const configuredPath = config.config.creationPromptPath;
  if (configuredPath === undefined || configuredPath === null) {
    return null;
  }
  const expanded = expandHome(configuredPath);
  return isAbsolute(expanded) ? expanded : resolve(dirname(config.configPath), expanded);
}

/** Parse global and trusted-project settings into the runtime configuration. */
export function loadGoalSettings(
  ctx: GoalSettingsContext,
  agentDir: string = getAgentDir(),
): GoalSettingsResult {
  try {
    const global = readConfig(getGoalGlobalConfigPath(agentDir));
    const project = ctx.isProjectTrusted()
      ? readConfig(join(ctx.cwd, CONFIG_DIR_NAME, EXTENSION_ID, CONFIG_BASENAME))
      : undefined;

    const promptConfig = project?.config.creationPromptPath === undefined ? global : project;
    const disabledTools =
      project?.config.disabledToolsWhileGoalActive ??
      global?.config.disabledToolsWhileGoalActive ??
      [];

    return {
      ok: true,
      settings: {
        creationPromptPath: resolvePromptPath(promptConfig),
        activeGoalToolPolicy: normalizeActiveGoalToolPolicy(disabledTools),
      },
    };
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : "Unknown settings error.";
    return { ok: false, message: `Could not load pi-codex-goal settings: ${message}` };
  }
}
