import path from "node:path";
import { fileURLToPath } from "node:url";

export const SYNTAX_THEME_NAME = "pi-glowup-darker-modern";
export const SYNTAX_THEME_APPEARANCE = "dark" as const;

declare global {
    interface ImportMeta {
        /** Relative asset path supplied when the extension is bundled. */
        readonly glowupThemeDirectory?: string;
    }
}

const BUNDLED_THEME_DIRECTORY = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    import.meta.glowupThemeDirectory ?? "../../../themes",
);

const BUNDLED_THEME_FILE = "darker-modern-theme.json";

export function bundledSyntaxThemePath(): string {
    return path.join(BUNDLED_THEME_DIRECTORY, BUNDLED_THEME_FILE);
}
