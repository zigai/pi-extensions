import type { ThemedToken } from "shiki";
import { colorBracketPairsInTokenRows } from "./brackets.ts";

const ANSI_RESET = "\u001b[0m";
const ANSI_FG_RESET = "\u001b[39m";
const ANSI_BG_RESET = "\u001b[49m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_BOLD_RESET = "\u001b[22m";
const ANSI_ITALIC = "\u001b[3m";
const ANSI_ITALIC_RESET = "\u001b[23m";
const ANSI_UNDERLINE = "\u001b[4m";
const ANSI_UNDERLINE_RESET = "\u001b[24m";
const ANSI_STRIKETHROUGH = "\u001b[9m";
const ANSI_STRIKETHROUGH_RESET = "\u001b[29m";

type AnsiTokenStyle = {
  readonly color: string | undefined;
  readonly bgColor: string | undefined;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strikethrough: boolean;
};

const EMPTY_STYLE: AnsiTokenStyle = {
  color: undefined,
  bgColor: undefined,
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
  return `${rendered}${ANSI_RESET}`;
}

function styleFromToken(token: ThemedToken): AnsiTokenStyle {
  const fontStyle = token.fontStyle ?? 0;
  return {
    color: normalizeHexColor(token.color),
    bgColor: normalizeHexColor(token.bgColor),
    bold: (fontStyle & 2) !== 0,
    italic: (fontStyle & 1) !== 0,
    underline: (fontStyle & 4) !== 0,
    strikethrough: (fontStyle & 8) !== 0,
  };
}

function transitionAnsi(previous: AnsiTokenStyle, next: AnsiTokenStyle): string {
  let ansi = "";

  if (previous.bold !== next.bold) {
    ansi += next.bold ? ANSI_BOLD : ANSI_BOLD_RESET;
  }
  if (previous.italic !== next.italic) {
    ansi += next.italic ? ANSI_ITALIC : ANSI_ITALIC_RESET;
  }
  if (previous.underline !== next.underline) {
    ansi += next.underline ? ANSI_UNDERLINE : ANSI_UNDERLINE_RESET;
  }
  if (previous.strikethrough !== next.strikethrough) {
    ansi += next.strikethrough ? ANSI_STRIKETHROUGH : ANSI_STRIKETHROUGH_RESET;
  }
  if (previous.color !== next.color) {
    ansi += next.color ? fgAnsi(next.color) : ANSI_FG_RESET;
  }
  if (previous.bgColor !== next.bgColor) {
    ansi += next.bgColor ? bgAnsi(next.bgColor) : ANSI_BG_RESET;
  }

  return ansi;
}

function fgAnsi(hex: string): string {
  const rgb = hexToRgb(hex);
  return rgb ? `\u001b[38;2;${rgb.red};${rgb.green};${rgb.blue}m` : "";
}

function bgAnsi(hex: string): string {
  const rgb = hexToRgb(hex);
  return rgb ? `\u001b[48;2;${rgb.red};${rgb.green};${rgb.blue}m` : "";
}

function normalizeHexColor(color: string | undefined): string | undefined {
  if (!color) {
    return undefined;
  }

  const hex = color.trim();
  if (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(hex)) {
    return hex.slice(0, 7);
  }
  if (/^#[0-9a-f]{3}$/iu.test(hex)) {
    const [, red = "", green = "", blue = ""] = hex;
    return `#${red}${red}${green}${green}${blue}${blue}`;
  }
  return undefined;
}

function hexToRgb(
  hex: string,
): { readonly red: number; readonly green: number; readonly blue: number } | undefined {
  const match = /^#(?<red>[0-9a-f]{2})(?<green>[0-9a-f]{2})(?<blue>[0-9a-f]{2})$/iu.exec(hex);
  if (!match?.groups) {
    return undefined;
  }

  return {
    red: Number.parseInt(match.groups.red ?? "0", 16),
    green: Number.parseInt(match.groups.green ?? "0", 16),
    blue: Number.parseInt(match.groups.blue ?? "0", 16),
  };
}
