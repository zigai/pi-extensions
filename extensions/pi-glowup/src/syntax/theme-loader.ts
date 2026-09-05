import { readFile } from "node:fs/promises";
import type { ThemeRegistration } from "shiki";
import { bundledSyntaxThemePath, SYNTAX_THEME_NAME } from "./theme-assets.ts";
import { jsonObjectParser, type JsonObject } from "../json-value.ts";
import { previewValueDecoder } from "../third-party-tools/previews.ts";

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
            : bundledSyntaxThemePath();
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

function parseThemeRegistration(value: unknown, themeName: string): ThemeRegistration {
    const record = jsonObjectParser.parse(value);
    if (record === undefined) {
        throw new Error("Syntax theme JSON must be an object");
    }

    const colorsRecord = jsonObjectParser.parse(record.colors);
    const colors = colorsRecord !== undefined ? stringRecord(colorsRecord) : undefined;
    const tokenColors = Array.isArray(record.tokenColors) ? record.tokenColors : undefined;
    if (tokenColors === undefined) {
        throw new Error("Syntax theme JSON must include tokenColors");
    }

    const registration =
        colors === undefined
            ? { ...record, name: themeName }
            : { ...record, name: themeName, colors };
    // SAFETY: Record parsing proves the structure of ThemeRegistration for Shiki.
    return { ...registration, tokenColors } as ThemeRegistration;
}

interface ThemeColors {
    readonly [key: string]: string;
}

function stringRecord(record: JsonObject): ThemeColors {
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
        const str = previewValueDecoder.parseString(value);
        if (str !== undefined) {
            output[key] = str;
        }
    }
    return output;
}
