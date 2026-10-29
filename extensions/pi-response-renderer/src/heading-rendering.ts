import {
    Markdown,
    parseColor,
    styleText,
    type Component,
    type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
    installLinkedMethodPatch,
    warnPiInternalPatchUnavailable,
} from "@zigai/pi-extension-internals";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { shouldHideFences } from "./markdown-rendering.ts";

const headingSchema = Type.Object({
    type: Type.Literal("heading"),
    depth: Type.Number({ minimum: 1, maximum: 6 }),
    text: Type.String(),
});
const tokenCacheSchema = Type.Object({ tokens: Type.Array(Type.Unknown()) });
const textStyle = Type.Function([Type.String()], Type.String());
const themeSchema = Type.Object({
    heading: textStyle,
    link: textStyle,
    linkUrl: textStyle,
    code: textStyle,
    codeBlock: textStyle,
    codeBlockBorder: textStyle,
    quote: textStyle,
    quoteBorder: textStyle,
    hr: textStyle,
    listBullet: textStyle,
    bold: textStyle,
    italic: textStyle,
    strikethrough: textStyle,
    underline: textStyle,
    codeBlockIndent: Type.Optional(Type.String()),
    highlightCode: Type.Optional(
        Type.Function([Type.String(), Type.Optional(Type.String())], Type.Array(Type.String())),
    ),
});
const hostSchema = Type.Object({
    render: Type.Function([Type.Number()], Type.Array(Type.String())),
    renderToken: Type.Function(
        [
            Type.Unknown(),
            Type.Number(),
            Type.Optional(Type.String()),
            Type.Optional(Type.Unknown()),
        ],
        Type.Array(Type.String()),
    ),
});
type HeadingHost = Static<typeof hostSchema>;

const foldable = new WeakSet();

type HeadingGroup = {
    children: Markdown[];
    depths?: number[];
    width?: number;
    hiddenDepth?: number;
    history: HeadingHistory;
    folds: Map<number, Set<number>>;
};

type HeadingSignature = { depth: number; text: string };
export type HeadingHistory = { signatures?: HeadingSignature[][] };

export function clearHeadingFolds(folds: Map<number, Set<number>>): void {
    for (const collapsed of folds.values()) collapsed.clear();
}

const groups = new WeakMap<object, HeadingGroup>();

export function createHeadingGroup(
    folds: Map<number, Set<number>>,
    history: HeadingHistory,
): HeadingGroup {
    return { children: [], folds, history };
}

export function resetHeadingFolds(group: HeadingGroup): void {
    group.hiddenDepth = undefined;
}

export function prepareHeadingGroup(group: HeadingGroup, width: number): void {
    if (group.width === width) return;

    group.width = width;

    const depths = new Set<number>();
    const signatures: HeadingSignature[][] = [];
    for (const markdown of group.children) {
        markdown.render(width);

        const cache: unknown = Object.getOwnPropertyDescriptor(markdown, "cachedTokens")?.value;
        if (!(cache instanceof WeakRef)) {
            clearHeadingFolds(group.folds);
            signatures.push([]);
            continue;
        }

        const value: unknown = cache.deref();
        if (!Value.Check(tokenCacheSchema, value)) {
            clearHeadingFolds(group.folds);
            signatures.push([]);
            continue;
        }
        const headings: HeadingSignature[] = [];
        for (const token of value.tokens) {
            if (!Value.Check(headingSchema, token)) continue;
            depths.add(token.depth);
            headings.push({ depth: token.depth, text: token.text });
        }
        signatures.push(headings);
    }

    const previous = group.history.signatures;
    if (previous !== undefined && !headingsPreserved(previous, signatures)) {
        clearHeadingFolds(group.folds);
    }

    group.history.signatures = signatures;
    group.depths = [...depths].sort((a, b) => a - b);
    for (const markdown of group.children) markdown.invalidate();
}

function headingsPreserved(previous: HeadingSignature[][], current: HeadingSignature[][]): boolean {
    if (current.length < previous.length) return false;
    return previous.every((headings, block) =>
        headings.every((heading, index) => {
            const next = current.at(block)?.at(index);
            if (next === undefined || next.depth !== heading.depth) return false;
            if (next.text === heading.text) return true;
            return (
                block === previous.length - 1 &&
                index === headings.length - 1 &&
                next.text.startsWith(heading.text)
            );
        }),
    );
}

const markerPattern = /\u001b\]9999;pi-fold:(\d+):(\d+)\u0007/g;
const endMarker = "\u001b]9999;pi-fold-end\u0007";

/** Pi's parser retains source heading depths in its token cache. Never alter those tokens. */
export function installHeadingRendering(): { dispose(): void } | undefined {
    const candidate: unknown = Markdown.prototype;
    if (!Value.Check(hostSchema, candidate)) {
        warnPiInternalPatchUnavailable("pi-response-renderer", "Markdown heading tokens");
        return undefined;
    }
    const host = candidate;

    return installLinkedMethodPatch(
        host,
        "renderToken",
        (predecessor) =>
            function (this: HeadingHost, token, width, next, context) {
                if (!shouldHideFences(this) || !Value.Check(headingSchema, token)) {
                    return predecessor.call(this, token, width, next, context);
                }

                const cache: unknown = Object.getOwnPropertyDescriptor(this, "cachedTokens")?.value;
                if (!(cache instanceof WeakRef))
                    return predecessor.call(this, token, width, next, context);
                const value: unknown = cache.deref();
                if (!Value.Check(tokenCacheSchema, value) || !value.tokens.includes(token)) {
                    return predecessor.call(this, token, width, next, context);
                }
                const theme: unknown = Object.getOwnPropertyDescriptor(this, "theme")?.value;
                if (!Value.Check(themeSchema, theme))
                    return predecessor.call(this, token, width, next, context);
                const headings = value.tokens.filter((item) => Value.Check(headingSchema, item));
                const depths =
                    groups.get(this)?.depths ??
                    [...new Set(headings.map((heading) => heading.depth))].sort((a, b) => a - b);
                const rank = depths.indexOf(token.depth);
                const yellow = (text: string): string =>
                    styleText(text, { fg: parseColor("#ffff00") }, "truecolor");

                const identity = (text: string): string => text;
                let bold = theme.bold;
                if (rank === 1) bold = identity;
                Reflect.set(this, "theme", {
                    ...theme,
                    heading: yellow,
                    bold,
                    underline: identity,
                });

                let lines: string[];

                try {
                    // The first two distinct depths omit markers; deeper headings keep their real depth.
                    let renderedToken = token;
                    if (rank >= 0 && rank < 2) renderedToken = { ...token, depth: 2 };
                    lines = predecessor.call(this, renderedToken, width, next, context);
                } finally {
                    Reflect.set(this, "theme", theme);
                }

                if (foldable.has(this) && lines.length > 0) {
                    const ordinal = headings.indexOf(token);
                    return [
                        `\u001b]9999;pi-fold:${token.depth}:${ordinal}\u0007${lines[0]}${endMarker}`,
                        ...lines.slice(1),
                    ];
                }

                return lines;
            },
    );
}

/** Mouse rows are derived from Pi's own wrapped render, not guessed from source text. */
export function foldableMarkdown(
    markdown: Markdown,
    collapsed: Set<number>,
    group: HeadingGroup,
): Component {
    foldable.add(markdown);
    groups.set(markdown, group);
    group.children.push(markdown);

    let rows = new Map<number, number>();

    return {
        render(width: number): string[] {
            const lines = markdown.render(width);
            const output: string[] = [];

            rows = new Map();

            let hiddenDepth = group.hiddenDepth;
            let pendingDepth: number | undefined;
            let headingOrdinal: number | undefined;

            for (const line of lines) {
                let depth: number | undefined;
                let ordinal: number | undefined;
                const endsHeading = line.includes(endMarker);
                const clean = line
                    .replaceAll(endMarker, "")
                    .replace(markerPattern, (_marker, d: string, n: string) => {
                        depth = Number(d);
                        ordinal = Number(n);
                        return "";
                    });
                if (depth !== undefined && ordinal !== undefined) {
                    if (hiddenDepth !== undefined && depth <= hiddenDepth) hiddenDepth = undefined;
                    if (hiddenDepth !== undefined) continue;
                    headingOrdinal = ordinal;
                    rows.set(output.length, ordinal);
                    output.push(clean);

                    if (collapsed.has(ordinal)) pendingDepth = depth;
                } else if (hiddenDepth === undefined) {
                    if (headingOrdinal !== undefined) rows.set(output.length, headingOrdinal);
                    output.push(clean);
                }

                if (endsHeading) {
                    headingOrdinal = undefined;

                    if (pendingDepth !== undefined) {
                        hiddenDepth = pendingDepth;
                        pendingDepth = undefined;
                    }
                }
            }

            group.hiddenDepth = hiddenDepth;
            return output;
        },
        invalidate(): void {
            markdown.invalidate();
        },
        handleMouse(event: TuiMouseEvent) {
            if (event.button !== "left" || event.shift) return undefined;
            if (event.type !== "press" && event.type !== "click") return undefined;

            const ordinal = rows.get(event.y);
            if (ordinal === undefined) return undefined;
            if (event.type === "press") return { handled: true, render: false };

            if (collapsed.has(ordinal)) collapsed.delete(ordinal);
            else collapsed.add(ordinal);

            return { handled: true };
        },
    };
}
