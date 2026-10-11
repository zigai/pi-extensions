import type { GlowupRenderTheme } from "../../src/rendering/theme.ts";

export function createPlainTheme(): GlowupRenderTheme {
    return {
        fg(_token: string, text: string): string {
            return text;
        },
        bg(_token: string, text: string): string {
            return text;
        },
        bold(text: string): string {
            return text;
        },
    };
}
