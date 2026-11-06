import {
    Markdown,
    type DefaultTextStyle,
    type MarkdownOptions,
    type MarkdownTheme,
} from "@earendil-works/pi-tui";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ANSI_OSC_REGEX = new RegExp(`${ESC}\\][^${BEL}]*${BEL}`, "g");
const ANSI_CSI_REGEX = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const ANSI_SGR_REGEX = new RegExp(`${ESC}\\[([0-9;]*)m`, "g");
const FENCE_LINE_REGEX = /^`{3,}[^`]*$/;
const fencesHiddenInstances = new WeakSet();
const tableBoundaryLineTextsByMarkdown = new WeakMap<Pick<Markdown, "render">, Set<string>>();

function stripAnsi(text: string): string {
    return text.replace(ANSI_OSC_REGEX, "").replace(ANSI_CSI_REGEX, "");
}

export function stripItalicAnsi(text: string): string {
    return text.replace(ANSI_SGR_REGEX, (_match, params: string) => {
        let codes: string[] = [];
        if (params.length > 0) {
            codes = params.split(";").filter((code) => code.length > 0);
        }

        const filtered = codes.filter((code) => code !== "3" && code !== "23");
        if (filtered.length === 0) {
            return "";
        }

        return `\u001b[${filtered.join(";")}m`;
    });
}

export function isFenceLine(line: string): boolean {
    return FENCE_LINE_REGEX.test(stripAnsi(line).trim());
}

function isBlankRenderedLine(line: string): boolean {
    return stripAnsi(line).trim().length === 0;
}

export type MarkdownRender = (this: Markdown, width: number) => string[];

type StyledMarkdownInstance = {
    text?: string;
    paddingX?: number;
    theme?: MarkdownTheme;
    defaultTextStyle?: DefaultTextStyle;
    options?: MarkdownOptions;
};

type MarkdownDataDescriptor = Omit<PropertyDescriptor, "value"> & { readonly value: unknown };

function isMarkdownDataDescriptor(
    descriptor: PropertyDescriptor | undefined,
): descriptor is MarkdownDataDescriptor {
    return descriptor !== undefined && Object.hasOwn(descriptor, "value");
}

// oxlint-disable-next-line antislop/no-object-parameters -- Markdown themes and option bags are intentionally structural objects.
function ownDataDescriptor(target: object, key: string): MarkdownDataDescriptor | undefined {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!isMarkdownDataDescriptor(descriptor)) return undefined;
    return descriptor;
}

function isMarkdownTheme(value: unknown): value is MarkdownTheme {
    if (typeof value !== "object" || value === null) return false;

    const functionKeys = [
        "heading",
        "link",
        "linkUrl",
        "code",
        "codeBlock",
        "codeBlockBorder",
        "quote",
        "quoteBorder",
        "hr",
        "listBullet",
        "bold",
        "italic",
        "strikethrough",
        "underline",
    ] as const;

    return functionKeys.every((key) => typeof ownDataDescriptor(value, key)?.value === "function");
}

function isBooleanOrUndefined(value: unknown): value is boolean | undefined {
    return value === undefined || typeof value === "boolean";
}

function isString(value: unknown): value is string {
    return typeof value === "string";
}

function isNumber(value: unknown): value is number {
    return typeof value === "number";
}

function isDefaultTextStyle(value: unknown): value is DefaultTextStyle {
    if (typeof value !== "object" || value === null) return false;

    if ("color" in value && value.color !== undefined && typeof value.color !== "function") {
        return false;
    }

    if ("bgColor" in value && value.bgColor !== undefined && typeof value.bgColor !== "function") {
        return false;
    }

    const booleanKeys = ["bold", "italic", "strikethrough", "underline"] as const;

    return booleanKeys.every((key) => {
        const property = ownDataDescriptor(value, key)?.value;
        return isBooleanOrUndefined(property);
    });
}

function isMarkdownOptions(value: unknown): value is MarkdownOptions {
    if (typeof value !== "object" || value === null) return false;

    const booleanKeys = [
        "preserveOrderedListMarkers",
        "preserveBackslashEscapes",
        "renderLatex",
    ] as const;
    if (
        !booleanKeys.every((key) => {
            const property = ownDataDescriptor(value, key)?.value;
            return isBooleanOrUndefined(property);
        })
    ) {
        return false;
    }

    return (
        !("transform" in value) ||
        value.transform === undefined ||
        typeof value.transform === "function"
    );
}

function getStyledMarkdownInstance(instance: Markdown): StyledMarkdownInstance {
    const styled: StyledMarkdownInstance = {};
    const text = ownDataDescriptor(instance, "text")?.value;
    if (isString(text)) styled.text = text;

    const paddingX = ownDataDescriptor(instance, "paddingX")?.value;
    if (isNumber(paddingX)) styled.paddingX = paddingX;

    const theme = ownDataDescriptor(instance, "theme")?.value;
    if (isMarkdownTheme(theme)) styled.theme = theme;

    const defaultTextStyle = ownDataDescriptor(instance, "defaultTextStyle")?.value;
    if (isDefaultTextStyle(defaultTextStyle)) styled.defaultTextStyle = defaultTextStyle;

    const options = ownDataDescriptor(instance, "options")?.value;
    if (isMarkdownOptions(options)) styled.options = options;

    return styled;
}

function markdownPaddingX(markdownInstance: StyledMarkdownInstance): number {
    const paddingX = markdownInstance.paddingX;
    if (paddingX !== undefined && Number.isFinite(paddingX) && paddingX >= 0) {
        return paddingX;
    }

    return 0;
}

type ThinkingMarkdownFrame = {
    readonly text: string;
    readonly paddingX: number;
    readonly theme: MarkdownTheme;
    readonly style: DefaultTextStyle;
    readonly options: MarkdownOptions | undefined;
    readonly colorSample: string;
    readonly markdown: Markdown;
};

const thinkingMarkdownFrames = new WeakMap<Markdown, ThinkingMarkdownFrame>();

export function invalidateThinkingMarkdown(instance: Markdown): void {
    thinkingMarkdownFrames.get(instance)?.markdown.invalidate();
}

/** Pi gives thinking Markdown a default foreground and italic style. */
export function resolveThinkingMarkdown(instance: Markdown): Markdown | undefined {
    const source = getStyledMarkdownInstance(instance);
    const { text, theme, defaultTextStyle: style, options } = source;
    if (
        text === undefined ||
        theme === undefined ||
        style?.italic !== true ||
        style.color === undefined
    ) {
        return undefined;
    }

    const paddingX = markdownPaddingX(source);
    const color = style.color;
    const colorSample = color("\u0000");
    const cached = thinkingMarkdownFrames.get(instance);
    if (
        cached?.text === text &&
        cached.paddingX === paddingX &&
        cached.theme === theme &&
        cached.style === style &&
        cached.options === options &&
        cached.colorSample === colorSample
    ) {
        return cached.markdown;
    }

    const identity = (value: string): string => value;
    const thinkingTheme: MarkdownTheme = {
        heading: color,
        link: color,
        linkUrl: color,
        code: (value) => theme.bold(color(value)),
        codeBlock: color,
        codeBlockBorder: color,
        quote: color,
        quoteBorder: color,
        hr: color,
        listBullet: color,
        bold: theme.bold,
        // Keep Pi's semantic thinking flag on the default style for other render patches,
        // but suppress the visual italics here.
        italic: identity,
        strikethrough: theme.strikethrough,
        underline: theme.underline,
        codeBlockIndent: theme.codeBlockIndent,
    };
    const markdown = new Markdown(text, paddingX, 0, thinkingTheme, style, options);
    thinkingMarkdownFrames.set(instance, {
        text,
        paddingX,
        theme,
        style,
        options,
        colorSample,
        markdown,
    });

    return markdown;
}

type HeadingLineTextsCache = {
    readonly text: string;
    readonly width: number;
    readonly paddingX: number;
    readonly theme: MarkdownTheme;
    readonly defaultTextStyle: DefaultTextStyle | undefined;
    readonly options: MarkdownOptions | undefined;
    readonly value: ReadonlySet<string>;
};

const EMPTY_HEADING_LINE_TEXTS: ReadonlySet<string> = new Set();
const headingLineTextsByMarkdown = new WeakMap<object, HeadingLineTextsCache>();

function getStylePrefix(styleFn: (text: string) => string): string {
    const sentinel = "\u0000";
    const styled = styleFn(sentinel);
    const sentinelIndex = styled.indexOf(sentinel);
    if (sentinelIndex >= 0) {
        return styled.slice(0, sentinelIndex);
    }

    return "";
}

function normalizeRenderedLine(line: string): string {
    return stripAnsi(line).trim();
}

function isAtxLevelOneOrTwoHeadingLine(line: string): boolean {
    return /^ {0,3}#{1,2}(?!#)(?:[ \t]+|$)/.test(line);
}

function getFenceSequence(line: string): string | undefined {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (match === null) {
        return undefined;
    }

    return match[1];
}

function getLevelOneOrTwoHeadingSources(markdown: string): string[] {
    const headings: string[] = [];
    let fenceSequence: string | undefined;

    for (const line of markdown.split(/\r?\n/)) {
        const nextFenceSequence = getFenceSequence(line);
        if (nextFenceSequence !== undefined) {
            if (fenceSequence === undefined) {
                fenceSequence = nextFenceSequence;
                continue;
            }

            const fenceCharacter = fenceSequence.at(0);
            if (
                fenceCharacter !== undefined &&
                nextFenceSequence.startsWith(fenceCharacter) &&
                nextFenceSequence.length >= fenceSequence.length
            ) {
                fenceSequence = undefined;
            }
            continue;
        }

        if (fenceSequence !== undefined) {
            continue;
        }

        if (isAtxLevelOneOrTwoHeadingLine(line)) {
            headings.push(line);
        }
    }

    return headings;
}

function cacheMatchesHeadingRenderInputs(
    cache: HeadingLineTextsCache,
    markdownInstance: StyledMarkdownInstance,
    text: string,
    width: number,
    paddingX: number,
    theme: MarkdownTheme,
): boolean {
    return (
        cache.text === text &&
        cache.width === width &&
        cache.paddingX === paddingX &&
        cache.theme === theme &&
        cache.defaultTextStyle === markdownInstance.defaultTextStyle &&
        cache.options === markdownInstance.options
    );
}

function cacheHeadingLineTexts(
    instance: Markdown,
    markdownInstance: StyledMarkdownInstance,
    text: string,
    width: number,
    paddingX: number,
    theme: MarkdownTheme,
    value: ReadonlySet<string>,
): ReadonlySet<string> {
    headingLineTextsByMarkdown.set(instance, {
        text,
        width,
        paddingX,
        theme,
        defaultTextStyle: markdownInstance.defaultTextStyle,
        options: markdownInstance.options,
        value,
    });

    return value;
}

export function resolveHeadingLineTexts(
    instance: Markdown,
    width: number,
    renderMarkdown: MarkdownRender,
): ReadonlySet<string> {
    const markdownInstance = getStyledMarkdownInstance(instance);
    const text = markdownInstance.text;
    if (text === undefined) {
        return EMPTY_HEADING_LINE_TEXTS;
    }

    const theme = markdownInstance.theme;
    if (theme === undefined) {
        return EMPTY_HEADING_LINE_TEXTS;
    }

    const paddingX = markdownPaddingX(markdownInstance);
    const cached = headingLineTextsByMarkdown.get(instance);
    if (
        cached !== undefined &&
        cacheMatchesHeadingRenderInputs(cached, markdownInstance, text, width, paddingX, theme)
    ) {
        return cached.value;
    }

    const headingSources = getLevelOneOrTwoHeadingSources(text);
    if (headingSources.length === 0) {
        return cacheHeadingLineTexts(
            instance,
            markdownInstance,
            text,
            width,
            paddingX,
            theme,
            EMPTY_HEADING_LINE_TEXTS,
        );
    }

    const headingLines = new Set<string>();
    for (const headingSource of headingSources) {
        const headingMarkdown = new Markdown(
            headingSource,
            paddingX,
            0,
            theme,
            markdownInstance.defaultTextStyle,
            markdownInstance.options,
        );
        for (const line of renderMarkdown.call(headingMarkdown, width)) {
            if (!isBlankRenderedLine(line)) {
                headingLines.add(normalizeRenderedLine(line));
            }
        }
    }

    return cacheHeadingLineTexts(
        instance,
        markdownInstance,
        text,
        width,
        paddingX,
        theme,
        headingLines,
    );
}

export function resolveHeadingPrefix(instance: Markdown): string {
    // Level 1-2 headings render without `#`, so use their ANSI heading prefix.
    const theme = getStyledMarkdownInstance(instance).theme;
    if (typeof theme?.heading !== "function") {
        return "";
    }

    return getStylePrefix(theme.heading);
}

type LineClassification = {
    intro: boolean;
    introduced: boolean;
    paragraph: boolean;
};

type PresentedLine = {
    raw: string;
    plain: string;
    trimmed: string;
    classification?: LineClassification;
};

function classifyLine(
    line: PresentedLine,
    headingPrefix: string,
    headingLineTexts: ReadonlySet<string>,
): LineClassification {
    if (line.classification !== undefined) return line.classification;
    const { raw, plain, trimmed } = line;
    const start = plain.trimStart();
    const intro = plain.trimEnd().endsWith(":");
    const list = /^[-*+]\s+/.test(start) || /^\d+[.)]\s+/.test(start);
    const fence = start.startsWith("```");
    const pipe = start.startsWith("|");
    const introduced = list || fence || pipe || /^ {2,}\S/.test(plain);
    const heading =
        /^#{1,6}\s+\S/.test(start) ||
        (headingPrefix.length > 0 && raw.trimStart().startsWith(headingPrefix)) ||
        headingLineTexts.has(trimmed);
    const table = /^[\u2500-\u257F]/.test(start);
    const microHeading =
        trimmed.length > 0 &&
        trimmed.length <= 48 &&
        !heading &&
        !table &&
        !/[.!?;:]$/.test(trimmed) &&
        !list &&
        !pipe &&
        !fence;
    const paragraph =
        trimmed.length > 0 && !heading && !table && !microHeading && !intro && !introduced;
    const classification = { intro, introduced, paragraph };
    line.classification = classification;
    return classification;
}

function* presentedLines(
    lines: readonly string[],
    hideFences: boolean,
): Generator<PresentedLine, undefined> {
    for (const raw of lines) {
        const plain = stripAnsi(raw);
        const trimmed = plain.trim();
        if (hideFences && FENCE_LINE_REGEX.test(trimmed)) continue;
        yield { raw, plain, trimmed };
    }
}

export function collapseAssistantBlankLines(
    lines: string[],
    headingPrefix: string,
    headingLineTexts: ReadonlySet<string>,
    tableBoundaryLineTexts?: ReadonlySet<string>,
    hideFences = false,
): string[] {
    // A frame owns plain text and classifications. A three-line window suffices: each
    // source line is stripped/classified at most once without retaining whole-frame metadata.
    const presented = presentedLines(lines, hideFences);
    const output: string[] = [];
    let previous: PresentedLine | undefined;
    let current = presented.next().value;
    let next = presented.next().value;
    while (current !== undefined) {
        let collapse = false;
        if (
            current.trimmed.length === 0 &&
            previous !== undefined &&
            next !== undefined &&
            tableBoundaryLineTexts?.has(previous.trimmed) !== true &&
            tableBoundaryLineTexts?.has(next.trimmed) !== true
        ) {
            const left = classifyLine(previous, headingPrefix, headingLineTexts);
            const right = classifyLine(next, headingPrefix, headingLineTexts);
            collapse = (left.intro && right.introduced) || (left.paragraph && right.paragraph);
        }
        if (!collapse) output.push(current.raw);
        previous = current;
        current = next;
        next = presented.next().value;
    }
    return output;
}

export function recordTableBoundaryLines(
    instance: Pick<Markdown, "render">,
    lines: readonly string[],
): void {
    const content = lines.filter((line) => !isBlankRenderedLine(line));
    const first = content.at(0);
    const last = content.at(-1);
    if (first === undefined || last === undefined) return;

    let boundaries = tableBoundaryLineTextsByMarkdown.get(instance);
    if (boundaries === undefined) {
        boundaries = new Set();
        tableBoundaryLineTextsByMarkdown.set(instance, boundaries);
    }

    boundaries.add(normalizeRenderedLine(first));
    boundaries.add(normalizeRenderedLine(last));
}

export function getTableBoundaryLineTexts(
    instance: Pick<Markdown, "render">,
): ReadonlySet<string> | undefined {
    return tableBoundaryLineTextsByMarkdown.get(instance);
}

export function clearTableBoundaryLines(instance: Pick<Markdown, "render">): void {
    tableBoundaryLineTextsByMarkdown.delete(instance);
}

export function shouldHideFences(instance: Pick<Markdown, "render">): boolean {
    return fencesHiddenInstances.has(instance);
}

export function markFencesHidden(instance: Markdown): void {
    fencesHiddenInstances.add(instance);
}
