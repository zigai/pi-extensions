import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import ansiStyles from "ansi-styles";
import { omittedLinesLabel, fitToWidth } from "../../rendering/component.ts";
import { dim, type GlowupRenderTheme } from "../../rendering/theme.ts";
import { trimEdgeBlankLines } from "../../rendering/output.ts";
import {
    highlightCodeOutput,
    scheduleCodeOutputSyntaxLoad,
} from "../../rendering/syntax/code-component.ts";
import {
    observeSyntaxHighlightSource,
    syntaxHighlightingVersion,
} from "../../rendering/syntax/highlighter.ts";
import type { GlowupPreview } from "./nodes.ts";

/** Bounds already-rendered physical rows, without reparsing or stripping semantic styles. */
export function previewRenderedRows(
    rows: readonly string[],
    theme: GlowupRenderTheme,
    preview: GlowupPreview | undefined,
    expanded: boolean,
    width: number,
    defaultCollapsed = 6,
): string[] {
    const mode = preview?.mode ?? "headTail";
    if (!expanded && mode === "hidden") return [];

    const limit = Math.max(
        1,
        Math.floor(
            expanded
                ? (preview?.expandedLines ?? 500)
                : (preview?.collapsedLines ?? defaultCollapsed),
        ),
    );
    if (rows.length <= limit) return [...rows];

    const marker = fitToWidth(dim(theme, omittedLinesLabel(rows.length - limit)), width, "…");
    if (expanded || mode === "head") return [...rows.slice(0, limit), marker];

    const head = Math.ceil(limit / 2);
    const tail = Math.floor(limit / 2);
    return [...rows.slice(0, head), marker, ...(tail === 0 ? [] : rows.slice(-tail))];
}

/** Own one native parser and its bounded/weak caches for one live content component. */
export function createMarkdownRows(theme: GlowupRenderTheme, invalidate: (() => void) | undefined) {
    let source: string | undefined;
    let current: (() => boolean) | undefined;
    let version = syntaxHighlightingVersion();
    const markdownTheme: MarkdownTheme = {
        heading: (value) => theme.fg("mdHeading", theme.bold(value)),
        link: (value) => theme.fg("mdLink", value),
        linkUrl: (value) => theme.fg("mdLinkUrl", value),
        code: (value) => theme.fg("mdCode", value),
        codeBlock: (value) => theme.fg("mdCodeBlock", value),
        codeBlockBorder: (value) => theme.fg("mdCodeBlockBorder", value),
        quote: (value) => theme.fg("mdQuote", value),
        quoteBorder: (value) => theme.fg("mdQuoteBorder", value),
        hr: (value) => theme.fg("mdHr", value),
        listBullet: (value) => theme.fg("mdListBullet", value),
        bold: (value) => theme.bold(value),
        italic: (value) => `${ansiStyles.italic.open}${value}${ansiStyles.italic.close}`,
        strikethrough: (value) =>
            `${ansiStyles.strikethrough.open}${value}${ansiStyles.strikethrough.close}`,
        underline: (value) => `${ansiStyles.underline.open}${value}${ansiStyles.underline.close}`,
        highlightCode: (code, language) => {
            const syntax = { ...(language !== undefined && { language }), invalidate };
            scheduleCodeOutputSyntaxLoad(syntax, invalidate, code, current);
            return highlightCodeOutput(code, syntax);
        },
    };

    const markdown = new Markdown("", 0, 0, markdownTheme);
    const invalidateMarkdown = markdown.invalidate.bind(markdown);

    // Pi's Markdown syntax integration may own fence jobs itself. Forward its repaint
    // through the enclosing protocol component as well as clearing the native cache.
    markdown.invalidate = () => {
        invalidateMarkdown();
        invalidate?.();
    };

    return {
        /** Transfer ownership without retaining the previous component or its theme. */
        update(nextTheme: GlowupRenderTheme, nextInvalidate: (() => void) | undefined): void {
            if (theme !== nextTheme) invalidateMarkdown();
            theme = nextTheme;
            invalidate = nextInvalidate;
        },
        /** Check before the enclosing row cache, including for short content. */
        syncSyntaxVersion(): boolean {
            const next = syntaxHighlightingVersion();
            if (version === next) return false;

            version = next;
            invalidateMarkdown();

            return true;
        },
        invalidate: invalidateMarkdown,
        render(nextSource: string, width: number): string[] {
            if (source !== nextSource) {
                source = nextSource;
                markdown.setText(source);
            }

            // Own the *visible* stream, not the raw node: observing both with the
            // same callback would cancel fence jobs on every streaming redraw.
            if (invalidate !== undefined)
                current = observeSyntaxHighlightSource(source, invalidate);

            if (source.trim().length === 0) return [];
            return trimEdgeBlankLines(markdown.render(Math.max(1, width)));
        },
    };
}

/** One-shot adapter for renderers without component-local Markdown ownership. */
export function markdownRows(
    source: string,
    theme: GlowupRenderTheme,
    width: number,
    invalidate: (() => void) | undefined,
): string[] {
    return createMarkdownRows(theme, invalidate).render(source, width);
}
