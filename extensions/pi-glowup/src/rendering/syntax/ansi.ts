import ansiStyles from "ansi-styles";
import type { ThemedToken } from "shiki";
import { colorBracketPairsInTokenRows } from "./brackets.ts";

type AnsiTokenStyle = {
    readonly color: string | undefined;
    readonly bold: boolean;
    readonly italic: boolean;
    readonly underline: boolean;
    readonly strikethrough: boolean;
};

const EMPTY_STYLE: AnsiTokenStyle = {
    color: undefined,
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
};

/** Converts Shiki themed token rows into truecolor ANSI terminal lines. */
export function tokensToAnsiLines(
    tokenRows: ReadonlyArray<ReadonlyArray<ThemedToken>>,
    language?: string,
): string[] {
    return colorBracketPairsInTokenRows(tokenRows, language).map(tokensToAnsiLine);
}

function tokensToAnsiLine(tokens: ReadonlyArray<ThemedToken>): string {
    let active = EMPTY_STYLE;
    let rendered = "";

    for (const token of tokens) {
        const next = styleFromToken(token);
        rendered += transitionAnsi(active, next);
        rendered += token.content;
        active = next;
    }

    if (rendered.length === 0) {
        return "";
    }
    return `${rendered}${resetAnsi(active)}`;
}

function styleFromToken(token: ThemedToken): AnsiTokenStyle {
    const fontStyle = token.fontStyle ?? 0;
    return {
        color: normalizeHexColor(token.color),
        bold: (fontStyle & 2) !== 0,
        italic: (fontStyle & 1) !== 0,
        underline: (fontStyle & 4) !== 0,
        strikethrough: (fontStyle & 8) !== 0,
    };
}

function resetAnsi(style: AnsiTokenStyle): string {
    return transitionAnsi(style, EMPTY_STYLE);
}

function transitionAnsi(previous: AnsiTokenStyle, next: AnsiTokenStyle): string {
    let ansi = "";

    if (previous.bold !== next.bold) {
        ansi += next.bold ? ansiStyles.modifier.bold.open : ansiStyles.modifier.bold.close;
    }
    if (previous.italic !== next.italic) {
        ansi += next.italic ? ansiStyles.modifier.italic.open : ansiStyles.modifier.italic.close;
    }
    if (previous.underline !== next.underline) {
        ansi += next.underline
            ? ansiStyles.modifier.underline.open
            : ansiStyles.modifier.underline.close;
    }
    if (previous.strikethrough !== next.strikethrough) {
        ansi += next.strikethrough
            ? ansiStyles.modifier.strikethrough.open
            : ansiStyles.modifier.strikethrough.close;
    }
    if (previous.color !== next.color) {
        ansi += next.color === undefined ? ansiStyles.color.close : fgAnsi(next.color);
    }

    return ansi;
}

function fgAnsi(hex: string): string {
    const [red, green, blue] = ansiStyles.hexToRgb(hex);
    return ansiStyles.color.ansi16m(red, green, blue);
}

function normalizeHexColor(color: string | undefined): string | undefined {
    if (color === undefined) {
        return undefined;
    }

    const hex = color.trim();
    if (hex.length === 0) {
        return undefined;
    }
    if (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(hex)) {
        return hex.slice(0, 7);
    }
    if (/^#[0-9a-f]{3}$/iu.test(hex)) {
        const [, red = "", green = "", blue = ""] = hex;
        return `#${red}${red}${green}${green}${blue}${blue}`;
    }
    return undefined;
}
