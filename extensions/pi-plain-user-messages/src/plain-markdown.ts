import {
    Text,
    type Component,
    type DefaultTextStyle,
    type MarkdownTheme,
} from "@earendil-works/pi-tui";

type MarkdownInternals = {
    readonly text: string;
    readonly paddingX: number;
    readonly paddingY: number;
    readonly defaultTextStyle: DefaultTextStyle | undefined;
    readonly theme: MarkdownTheme | undefined;
};

type MarkdownCandidate = {
    readonly text?: unknown;
    readonly paddingX?: unknown;
    readonly paddingY?: unknown;
    readonly defaultTextStyle?: unknown;
    readonly theme?: unknown;
    readonly constructor?: { readonly name?: unknown };
    readonly renderToken?: unknown;
};

type ParsedMarkdownCandidate = {
    readonly text: string;
    readonly paddingX?: unknown;
    readonly paddingY?: unknown;
    readonly defaultTextStyle?: DefaultTextStyle;
    readonly theme?: MarkdownTheme;
};

type DefaultTextStyleView = {
    readonly color?: unknown;
    readonly bgColor?: unknown;
    readonly bold?: unknown;
    readonly italic?: unknown;
    readonly strikethrough?: unknown;
    readonly underline?: unknown;
};

type MarkdownThemeView = {
    readonly heading?: unknown;
    readonly link?: unknown;
    readonly linkUrl?: unknown;
    readonly code?: unknown;
    readonly codeBlock?: unknown;
    readonly codeBlockBorder?: unknown;
    readonly quote?: unknown;
    readonly quoteBorder?: unknown;
    readonly hr?: unknown;
    readonly listBullet?: unknown;
    readonly bold?: unknown;
    readonly italic?: unknown;
    readonly strikethrough?: unknown;
    readonly underline?: unknown;
    readonly highlightCode?: unknown;
    readonly codeBlockIndent?: unknown;
};

export type UserMessageComponentInstance = Component & {
    contentBox?: unknown;
    children?: unknown[];
};

type BoxLike = {
    children: unknown[];
    invalidate(): void;
};

type BoxCandidate = {
    readonly children?: unknown;
    readonly invalidate?: unknown;
};

function isObjectLike(value: unknown): value is object {
    return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isBoxLike(value: unknown): value is BoxLike {
    if (!isObjectLike(value)) {
        return false;
    }

    // SAFETY: The object/function check permits reading the two fields that this
    // predicate validates completely before claiming the mutable box contract.
    const candidate = value as BoxCandidate;
    return Array.isArray(candidate.children) && typeof candidate.invalidate === "function";
}

function isDefaultTextStyle(value: unknown): value is DefaultTextStyle {
    if (!isObjectLike(value)) return false;

    // SAFETY: The object/function check permits reading only fields whose complete
    // optional callable/boolean contracts are checked by this predicate.
    const style = value as DefaultTextStyleView;

    return (
        (style.color === undefined || typeof style.color === "function") &&
        (style.bgColor === undefined || typeof style.bgColor === "function") &&
        (style.bold === undefined || typeof style.bold === "boolean") &&
        (style.italic === undefined || typeof style.italic === "boolean") &&
        (style.strikethrough === undefined || typeof style.strikethrough === "boolean") &&
        (style.underline === undefined || typeof style.underline === "boolean")
    );
}

function isMarkdownTheme(value: unknown): value is MarkdownTheme {
    if (!isObjectLike(value)) return false;

    // SAFETY: The object/function check permits reading only the MarkdownTheme fields;
    // every required function and both optional contracts are checked below.
    const theme = value as MarkdownThemeView;

    return (
        typeof theme.heading === "function" &&
        typeof theme.link === "function" &&
        typeof theme.linkUrl === "function" &&
        typeof theme.code === "function" &&
        typeof theme.codeBlock === "function" &&
        typeof theme.codeBlockBorder === "function" &&
        typeof theme.quote === "function" &&
        typeof theme.quoteBorder === "function" &&
        typeof theme.hr === "function" &&
        typeof theme.listBullet === "function" &&
        typeof theme.bold === "function" &&
        typeof theme.italic === "function" &&
        typeof theme.strikethrough === "function" &&
        typeof theme.underline === "function" &&
        (theme.highlightCode === undefined || typeof theme.highlightCode === "function") &&
        (theme.codeBlockIndent === undefined || typeof theme.codeBlockIndent === "string")
    );
}

function isMarkdownCandidate(value: unknown): value is ParsedMarkdownCandidate {
    if (!isObjectLike(value)) return false;

    // SAFETY: The object/function check permits reading Pi's private Markdown fields;
    // every field consumed by the returned contract is checked below.
    const candidate = value as MarkdownCandidate;
    if (
        typeof candidate.text !== "string" ||
        (candidate.constructor?.name !== "Markdown" &&
            typeof candidate.renderToken !== "function") ||
        (candidate.defaultTextStyle !== undefined &&
            !isDefaultTextStyle(candidate.defaultTextStyle)) ||
        (candidate.theme !== undefined && !isMarkdownTheme(candidate.theme))
    ) {
        return false;
    }

    return true;
}

function isMarkdownPadding(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const markdownInternalsParser = {
    parse(value: unknown): MarkdownInternals | undefined {
        if (!isMarkdownCandidate(value)) {
            return undefined;
        }

        let paddingX = 0;
        if (isMarkdownPadding(value.paddingX)) {
            paddingX = value.paddingX;
        }

        let paddingY = 0;
        if (isMarkdownPadding(value.paddingY)) {
            paddingY = value.paddingY;
        }

        return {
            text: value.text,
            paddingX,
            paddingY,
            defaultTextStyle: value.defaultTextStyle,
            theme: value.theme,
        };
    },
};

export class PlainMarkdownText implements Component {
    private readonly text: string;
    private readonly paddingX: number;
    private readonly paddingY: number;
    private readonly defaultTextStyle: DefaultTextStyle | undefined;
    private readonly markdownTheme: MarkdownTheme | undefined;

    constructor(markdown: MarkdownInternals) {
        this.text = markdown.text;
        this.paddingX = markdown.paddingX;
        this.paddingY = markdown.paddingY;
        this.defaultTextStyle = markdown.defaultTextStyle;
        this.markdownTheme = markdown.theme;
    }

    invalidate(): void {
        return;
    }

    render(width: number): string[] {
        if (this.text.trim().length === 0) {
            return [];
        }

        const text = new Text(
            this.applyDefaultStyle(this.text),
            this.paddingX,
            this.paddingY,
            this.defaultTextStyle?.bgColor,
        );
        return text.render(width);
    }

    private applyDefaultStyle(text: string): string {
        const defaultTextStyle = this.defaultTextStyle;
        if (defaultTextStyle === undefined) {
            return text;
        }

        let styled = text;
        if (defaultTextStyle.color !== undefined) {
            styled = defaultTextStyle.color(styled);
        }

        const markdownTheme = this.markdownTheme;
        if (markdownTheme === undefined) {
            return styled;
        }

        if (defaultTextStyle.bold === true) {
            styled = markdownTheme.bold(styled);
        }

        if (defaultTextStyle.italic === true) {
            styled = markdownTheme.italic(styled);
        }

        if (defaultTextStyle.strikethrough === true) {
            styled = markdownTheme.strikethrough(styled);
        }

        if (defaultTextStyle.underline === true) {
            styled = markdownTheme.underline(styled);
        }

        return styled;
    }
}

function replaceMarkdownChildrenWithPlainText(contentBox: BoxLike): boolean {
    let replaced = false;

    for (let index = 0; index < contentBox.children.length; index++) {
        const child = contentBox.children[index];
        const markdown = markdownInternalsParser.parse(child);
        if (markdown !== undefined) {
            contentBox.children[index] = new PlainMarkdownText(markdown);
            replaced = true;
        }
    }

    if (replaced) {
        contentBox.invalidate();
    }

    return replaced;
}

function findUserMessageContentBox(instance: UserMessageComponentInstance): BoxLike | undefined {
    const candidates: unknown[] = [instance.contentBox, instance];
    const visited = new Set<object>();

    while (candidates.length > 0) {
        const candidate = candidates.pop();
        if (!isObjectLike(candidate) || visited.has(candidate)) {
            continue;
        }

        visited.add(candidate);

        if (!isBoxLike(candidate)) {
            continue;
        }

        if (
            candidate.children.some((child) => markdownInternalsParser.parse(child) !== undefined)
        ) {
            return candidate;
        }

        for (const child of candidate.children) {
            candidates.push(child);
        }
    }

    return undefined;
}

export function ensurePlainTextUserMessage(instance: UserMessageComponentInstance): void {
    const contentBox = findUserMessageContentBox(instance);
    if (contentBox === undefined) {
        return;
    }

    replaceMarkdownChildrenWithPlainText(contentBox);
}
