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

const foldable = new WeakMap<object, Set<number>>();

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
    const previousWidth = group.width;
    if (previousWidth === width) return;
    group.width = width;

    try {
        const renderedDepths = group.depths;
        const hadFolds = [...group.folds.values()].some((collapsed) => collapsed.size > 0);
        const depths = new Set<number>();
        const signatures: HeadingSignature[][] = [];
        const unsupported = new Set<Markdown>();
        for (const markdown of group.children) {
            // A new group can reuse SDK Markdown blocks from the preceding streamed content.
            // Their cached heading ranks/ordinals belong to that old group. Clear them before
            // discovery so its render can be reused instead of discovering stale markers.
            if (previousWidth === undefined) markdown.invalidate();
            markdown.render(width);

            const cache: unknown = Object.getOwnPropertyDescriptor(markdown, "cachedTokens")?.value;
            if (!(cache instanceof WeakRef)) {
                clearHeadingFolds(group.folds);
                unsupported.add(markdown);
                signatures.push([]);
                continue;
            }

            const value: unknown = cache.deref();
            if (!Value.Check(tokenCacheSchema, value)) {
                clearHeadingFolds(group.folds);
                unsupported.add(markdown);
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
        const nextDepths = [...depths].sort((a, b) => a - b);
        group.depths = nextDepths;
        const foldsCleared =
            hadFolds && ![...group.folds.values()].some((collapsed) => collapsed.size > 0);
        for (const [block, markdown] of group.children.entries()) {
            const headings = signatures[block] ?? [];
            const previousDepths =
                renderedDepths ??
                [...new Set(headings.map((heading) => heading.depth))].sort((a, b) => a - b);
            // The discovery render already produced the final lines when heading ranks and
            // fold indicators are unchanged. Invalidate only if those inputs actually changed;
            // keep normal theme/syntax/setText invalidation owned by the SDK and its callers.
            if (
                unsupported.has(markdown) ||
                foldsCleared ||
                headings.some(
                    (heading) =>
                        previousDepths.indexOf(heading.depth) !== nextDepths.indexOf(heading.depth),
                )
            )
                markdown.invalidate();
        }
        group.width = width;
    } catch (cause: unknown) {
        group.width = previousWidth;
        throw cause;
    }
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

type HeadingIndex = {
    ordinals: WeakMap<object, number>;
    depths: number[];
};

type HeadingRender = {
    cache?: object;
    index?: HeadingIndex;
};

function indexHeadings(tokens: unknown[]): HeadingIndex {
    const ordinals = new WeakMap<object, number>();
    const depths = new Set<number>();
    let ordinal = 0;
    for (const token of tokens) {
        if (!Value.Check(headingSchema, token)) continue;
        // Preserve indexOf's first ordinal even for unsupported duplicate token identities.
        if (!ordinals.has(token)) ordinals.set(token, ordinal);
        ordinal += 1;
        depths.add(token.depth);
    }
    return { ordinals, depths: [...depths].sort((a, b) => a - b) };
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

    // The SDK owns mutable tokens and retains them only weakly. Index them for one
    // synchronous render, never across renders (even when the cache identity survives).
    // This also observes foreign in-place token edits on the next render without
    // pinning the token tree for the lifetime of a transcript's Markdown component.
    const renders = new WeakMap<object, HeadingRender>();
    const renderPatch = installLinkedMethodPatch(
        host,
        "render",
        (predecessor) =>
            function (this: HeadingHost, width) {
                if (!shouldHideFences(this)) return predecessor.call(this, width);
                const previous = renders.get(this);
                renders.set(this, {});
                try {
                    return predecessor.call(this, width);
                } finally {
                    if (previous === undefined) renders.delete(this);
                    else renders.set(this, previous);
                }
            },
    );
    try {
        const tokenPatch = installLinkedMethodPatch(
            host,
            "renderToken",
            (predecessor) =>
                function (this: HeadingHost, token, width, next, context) {
                    if (!shouldHideFences(this) || !Value.Check(headingSchema, token)) {
                        return predecessor.call(this, token, width, next, context);
                    }

                    const cache: unknown = Object.getOwnPropertyDescriptor(
                        this,
                        "cachedTokens",
                    )?.value;
                    if (!(cache instanceof WeakRef))
                        return predecessor.call(this, token, width, next, context);
                    const value: unknown = cache.deref();
                    const render = renders.get(this);
                    let index = render?.index;
                    if (index === undefined || render?.cache !== value) {
                        if (!Value.Check(tokenCacheSchema, value)) {
                            return predecessor.call(this, token, width, next, context);
                        }
                        index = indexHeadings(value.tokens);
                        if (render !== undefined) {
                            render.cache = value;
                            render.index = index;
                        }
                    }
                    const ordinal = index.ordinals.get(token);
                    // Only top-level headings have ranks and fold ordinals. Nested headings
                    // still belong to their quote/list renderer and must use the predecessor.
                    if (ordinal === undefined)
                        return predecessor.call(this, token, width, next, context);
                    const theme: unknown = Object.getOwnPropertyDescriptor(this, "theme")?.value;
                    if (!Value.Check(themeSchema, theme))
                        return predecessor.call(this, token, width, next, context);
                    const depths = groups.get(this)?.depths ?? index.depths;
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

                    const collapsed = foldable.get(this);
                    if (collapsed !== undefined && lines.length > 0) {
                        let indicator = "";
                        if (collapsed.has(ordinal)) indicator = yellow("▸ ");
                        return [
                            `\u001b]9999;pi-fold:${token.depth}:${ordinal}\u0007${indicator}${lines[0]}${endMarker}`,
                            ...lines.slice(1),
                        ];
                    }

                    return lines;
                },
        );
        return {
            dispose(): void {
                try {
                    tokenPatch.dispose();
                } finally {
                    renderPatch.dispose();
                }
            },
        };
    } catch (cause: unknown) {
        renderPatch.dispose();
        throw cause;
    }
}

/** Mouse rows are derived from Pi's own wrapped render, not guessed from source text. */
export function foldableMarkdown(
    markdown: Markdown,
    collapsed: Set<number>,
    group: HeadingGroup,
): Component {
    foldable.set(markdown, collapsed);
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
            markdown.invalidate();

            return { handled: true };
        },
    };
}
