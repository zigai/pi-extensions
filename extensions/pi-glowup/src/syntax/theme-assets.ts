import path from "node:path";
import { fileURLToPath } from "node:url";

export const SYNTAX_THEME_NAME = "pi-codex-look-darker-modern";
export const SYNTAX_THEME_APPEARANCE = "dark" as const;

const BUNDLED_THEME_DIRECTORY = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../themes",
);

const BUNDLED_THEME_FILE = "darker-modern-theme.json";

export function bundledSyntaxThemePath(): string {
    return path.join(BUNDLED_THEME_DIRECTORY, BUNDLED_THEME_FILE);
}
