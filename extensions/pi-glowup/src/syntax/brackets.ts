import type { ThemedToken } from "shiki";
import { SYNTAX_ACCENT_COLORS } from "./palette.ts";

const BRACKET_PAIR_COLORS = SYNTAX_ACCENT_COLORS.bracketPair;
const BRACKET_COLORABLE_FOREGROUNDS = new Set<string>(SYNTAX_ACCENT_COLORS.neutralForegrounds);
const PYTHON_IMPORT_IDENTIFIER_COLOR = SYNTAX_ACCENT_COLORS.pythonImportIdentifier;
const PYTHON_CONSTANT_IDENTIFIER_COLOR = SYNTAX_ACCENT_COLORS.pythonConstantIdentifier;
const PYTHON_VARIABLE_IDENTIFIER_COLOR = SYNTAX_ACCENT_COLORS.pythonVariableIdentifier;
const PYTHON_FUNCTION_IDENTIFIER_COLOR = SYNTAX_ACCENT_COLORS.pythonFunctionIdentifier;
const OPEN_BRACKETS = new Set(["(", "[", "{"]);
const CLOSE_BRACKETS = new Set([")", "]", "}"]);

type BracketState = {
  depth: number;
};

type TextSegment = {
  readonly text: string;
  readonly fg?: string;
};

/** Applies VS Code-like bracket pair colors to otherwise-neutral punctuation tokens. */
export function colorBracketPairsInTokenRows(
  rows: ReadonlyArray<ReadonlyArray<ThemedToken>>,
  language?: string,
): ThemedToken[][] {
  const state: BracketState = { depth: 0 };
  return rows.map((row) =>
    colorPythonIdentifiersInTokens(row, language).flatMap((token) =>
      splitBracketText(token.content, token.color, state).map((part) => ({
        ...token,
        content: part.text,
        ...(part.color === undefined ? {} : { color: part.color }),
      })),
    ),
  );
}

/** Applies VS Code-like terminal syntax enhancements to already-flattened highlighted spans. */
export function enhanceSyntaxSegments<TSegment extends TextSegment>(
  segments: ReadonlyArray<TSegment>,
  language?: string,
): TSegment[] {
  const state: BracketState = { depth: 0 };
  return colorPythonIdentifiersInSegments(segments, language).flatMap((segment) =>
    splitBracketText(segment.text, segment.fg, state).map((part) => ({
      ...segment,
      text: part.text,
      ...(part.color === undefined ? {} : { fg: part.color }),
    })),
  );
}

function colorPythonIdentifiersInTokens(
  row: ReadonlyArray<ThemedToken>,
  language: string | undefined,
): ThemedToken[] {
  if (language !== "python") {
    return [...row];
  }
  const line = row.map((token) => token.content).join("");
  return row.flatMap((token) =>
    splitPythonIdentifiers(token.content, token.color, line).map((part) => ({
      ...token,
      content: part.text,
      ...(part.color === undefined ? {} : { color: part.color }),
    })),
  );
}

function colorPythonIdentifiersInSegments<TSegment extends TextSegment>(
  segments: ReadonlyArray<TSegment>,
  language: string | undefined,
): TSegment[] {
  if (language !== "python") {
    return [...segments];
  }
  const line = segments.map((segment) => segment.text).join("");
  return segments.flatMap((segment) =>
    splitPythonIdentifiers(segment.text, segment.fg, line).map((part) => ({
      ...segment,
      text: part.text,
      ...(part.color === undefined ? {} : { fg: part.color }),
    })),
  );
}

function splitPythonIdentifiers(
  text: string,
  foreground: string | undefined,
  line: string,
): Array<{ readonly text: string; readonly color?: string }> {
  if (!isBracketColorableForeground(foreground)) {
    return [{ text }];
  }
  const importLine = isPythonImportLine(line);
  const parts: Array<{ readonly text: string; readonly color?: string }> = [];
  let index = 0;
  for (const match of text.matchAll(/[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*/gu)) {
    const start = match.index ?? 0;
    const value = match[0] ?? "";
    if (start > index) {
      parts.push({ text: text.slice(index, start) });
    }
    parts.push({
      text: value,
      color: pythonIdentifierColor(value, text.slice(start + value.length), importLine),
    });
    index = start + value.length;
  }
  if (index < text.length) {
    parts.push({ text: text.slice(index) });
  }
  return parts.length > 0 ? parts : [{ text }];
}

function pythonIdentifierColor(value: string, suffix: string, importLine: boolean): string {
  if (importLine) {
    return PYTHON_IMPORT_IDENTIFIER_COLOR;
  }
  if (/^[A-Z_][A-Z0-9_]*$/u.test(value)) {
    return PYTHON_CONSTANT_IDENTIFIER_COLOR;
  }
  if (/^\s*\(/u.test(suffix)) {
    return PYTHON_FUNCTION_IDENTIFIER_COLOR;
  }
  return PYTHON_VARIABLE_IDENTIFIER_COLOR;
}

function isPythonImportLine(text: string): boolean {
  return /^\s*(?:from\s+\S+\s+import\s+\S+|import\s+\S+)/u.test(text);
}

function splitBracketText(
  text: string,
  foreground: string | undefined,
  state: BracketState,
): Array<{ readonly text: string; readonly color?: string }> {
  if (text.length === 0) {
    return [];
  }
  if (!isBracketColorableForeground(foreground) || !hasBracket(text)) {
    return [{ text }];
  }

  const parts: Array<{ readonly text: string; readonly color?: string }> = [];
  let plain = "";

  for (const char of text) {
    if (!isBracket(char)) {
      plain += char;
      continue;
    }

    if (plain.length > 0) {
      parts.push({ text: plain });
      plain = "";
    }
    parts.push({ text: char, color: bracketColor(char, state) });
  }

  if (plain.length > 0) {
    parts.push({ text: plain });
  }

  return parts;
}

function bracketColor(char: string, state: BracketState): string {
  if (CLOSE_BRACKETS.has(char)) {
    state.depth = Math.max(0, state.depth - 1);
    return BRACKET_PAIR_COLORS[state.depth % BRACKET_PAIR_COLORS.length] ?? BRACKET_PAIR_COLORS[0];
  }

  const color =
    BRACKET_PAIR_COLORS[state.depth % BRACKET_PAIR_COLORS.length] ?? BRACKET_PAIR_COLORS[0];
  if (OPEN_BRACKETS.has(char)) {
    state.depth += 1;
  }
  return color;
}

function hasBracket(text: string): boolean {
  return /[()[\]{}]/u.test(text);
}

function isBracket(char: string): boolean {
  return OPEN_BRACKETS.has(char) || CLOSE_BRACKETS.has(char);
}

function isBracketColorableForeground(foreground: string | undefined): boolean {
  if (foreground === undefined) {
    return true;
  }
  return BRACKET_COLORABLE_FOREGROUNDS.has(foreground.toLowerCase());
}
