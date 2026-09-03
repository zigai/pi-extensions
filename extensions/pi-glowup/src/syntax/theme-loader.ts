import { readFile } from "node:fs/promises";
import type { ThemeRegistration } from "shiki";
import { bundledSyntaxThemePath, SYNTAX_THEME_NAME } from "./theme-assets.ts";
import { isRecord, type UnknownRecord } from "../unknown-values.ts";

export { SYNTAX_THEME_NAME } from "./theme-assets.ts";

const SYNTAX_OFF_VALUE = "off";
const SYNTAX_ENV = "PI_GLOWUP_SYNTAX";
const SYNTAX_THEME_ENV = "PI_GLOWUP_SYNTAX_THEME";

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
        configuredThemePath !== undefined && configuredThemePath.length > 0
            ? configuredThemePath
            : defaultThemePath();
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

function defaultThemePath(): string {
    return bundledSyntaxThemePath();
}

function parseThemeRegistration(value: unknown, themeName: string): ThemeRegistration {
    if (!isRecord(value)) {
        throw new Error("Syntax theme JSON must be an object");
    }

    const colors = isRecord(value.colors) ? stringRecord(value.colors) : undefined;
    const tokenColors = Array.isArray(value.tokenColors) ? value.tokenColors : undefined;
    if (tokenColors === undefined) {
        throw new Error("Syntax theme JSON must include tokenColors");
    }

    const registration =
        colors === undefined ? { ...value, name: themeName } : { ...value, name: themeName, colors };
    return { ...registration, tokenColors } satisfies ThemeRegistration;
}

interface ThemeColors {
    readonly [key: string]: string;
}

function stringRecord(record: UnknownRecord): ThemeColors {
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
        if (typeof value === "string") {
            output[key] = value;
        }
    }
    return output;
}
