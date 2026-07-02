import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ThemeRegistration } from "shiki";

export const SYNTAX_THEME_NAME = "pi-codex-look-darker-modern";
const SYNTAX_OFF_VALUE = "off";
const SYNTAX_ENV = "PI_CODEX_LOOK_SYNTAX";
const SYNTAX_THEME_ENV = "PI_CODEX_LOOK_SYNTAX_THEME";
const SYNTAX_THEME_VARIANT_ENV = "PI_CODEX_LOOK_SYNTAX_THEME_VARIANT";
const DEFAULT_THEME_DIRECTORY = "/home/zigai/Projects/vscode-darker-plus/themes";
const DEFAULT_THEME_FILE = "darker-modern-theme.json";
const BLACK_THEME_FILE = "darker-modern-black-theme.json";

type UnknownRecord = {
  readonly [key: string]: unknown;
};

export type SyntaxConfig =
  | {
      readonly enabled: false;
      readonly reason: string;
    }
  | {
      readonly enabled: true;
      readonly themePath: string;
      readonly themeName: string;
    };

export type LoadedSyntaxTheme = {
  readonly name: string;
  readonly path: string;
  readonly registration: ThemeRegistration;
};

/** Parses syntax-rendering environment configuration at extension startup. */
export function loadSyntaxConfig(env: NodeJS.ProcessEnv = process.env): SyntaxConfig {
  if ((env[SYNTAX_ENV] ?? "").trim().toLowerCase() === SYNTAX_OFF_VALUE) {
    return { enabled: false, reason: `${SYNTAX_ENV}=off` };
  }

  const configuredThemePath = env[SYNTAX_THEME_ENV]?.trim();
  const themePath =
    configuredThemePath && configuredThemePath.length > 0
      ? configuredThemePath
      : defaultThemePath(env);
  return {
    enabled: true,
    themePath,
    themeName: SYNTAX_THEME_NAME,
  };
}

/** Loads and parses a VS Code/TextMate theme JSON file for Shiki. */
export async function loadSyntaxTheme(
  config: SyntaxConfig,
): Promise<LoadedSyntaxTheme | undefined> {
  if (!config.enabled) {
    return undefined;
  }

  const raw = await readFile(config.themePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const registration = parseThemeRegistration(parsed, config.themeName);
  return {
    name: config.themeName,
    path: config.themePath,
    registration,
  };
}

function defaultThemePath(env: NodeJS.ProcessEnv): string {
  const variant = env[SYNTAX_THEME_VARIANT_ENV]?.trim().toLowerCase();
  const fileName = variant === "black" ? BLACK_THEME_FILE : DEFAULT_THEME_FILE;
  return path.join(DEFAULT_THEME_DIRECTORY, fileName);
}

function parseThemeRegistration(value: unknown, themeName: string): ThemeRegistration {
  if (!isRecord(value)) {
    throw new Error("Syntax theme JSON must be an object");
  }

  const colors = isRecord(value.colors) ? stringRecord(value.colors) : undefined;
  const tokenColors = Array.isArray(value.tokenColors) ? value.tokenColors : undefined;
  if (!tokenColors) {
    throw new Error("Syntax theme JSON must include tokenColors");
  }

  return {
    ...value,
    name: themeName,
    ...(colors === undefined ? {} : { colors }),
    tokenColors,
  } satisfies ThemeRegistration;
}

function stringRecord(record: UnknownRecord): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") {
      output[key] = value;
    }
  }
  return output;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
