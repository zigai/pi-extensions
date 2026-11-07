import type { GlowupInline, GlowupTextNode } from "./nodes.ts";
import type { GlowupRenderTheme } from "../../rendering/theme.ts";

/** Keeps semantic inline styling consistent across compact and outline presentations. */
export function renderInline(theme: GlowupRenderTheme, value: GlowupInline): string {
    if (!(value instanceof Object) || !("kind" in value)) return value;

    const token: Parameters<GlowupRenderTheme["fg"]>[0] = (() => {
        switch (value.tone) {
            case "accent":
            case "path":
                return "accent";
            case "url":
                return "mdLinkUrl";
            case "success":
                return "success";
            case "error":
                return "error";
            case "dim":
                return "dim";
            case "muted":
                return "muted";
            case "code":
                return "syntaxString";
            case "default":
            case undefined:
                return "toolTitle";
        }

        return "toolTitle";
    })();
    const styled = theme.fg(token, value.text);
    return value.bold === true ? theme.bold(styled) : styled;
}

/** Styled parts replace only the presentation, never the producer's plain fallback. */
export function renderText(theme: GlowupRenderTheme, node: GlowupTextNode): string {
    return node.parts === undefined
        ? renderInline(theme, node.text)
        : node.parts.map((part) => renderInline(theme, part)).join("");
}
