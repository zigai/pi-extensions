import {
    type GlowupRenderTheme,
    dim,
    type GlowupCallState,
    renderBullet,
    actionText,
    muted,
} from "../../../rendering/theme.ts";
import {
    detectHeredocInterpreter,
    detectScriptInterpreter,
    embeddedInlineScripts,
    type ScriptInvocation,
} from "./invocation.ts";
import { highlightSyntaxCode } from "../../../rendering/syntax/highlighter.ts";
import { createSyntaxComponent } from "../../../rendering/syntax/component-owner.ts";
import {
    isPreviewMetaLine,
    highlightCodePreviewRuns,
    trimEdgeBlankLines,
    detachString,
    collapsedPreviewLinesFromText,
} from "../../../rendering/output.ts";
import { scheduleCodeOutputSyntaxLoad } from "../../../rendering/syntax/code-component.ts";
import { omitLeadingImportPrologue } from "./prologue.ts";
import { truncateUtf8ByGrapheme } from "../../../text-boundaries.ts";
import {
    wrapSinglePhysicalLineWithContinuation,
    toolExpandHint,
    makeComponent,
    wrapPrefixedLine,
} from "../../../rendering/component.ts";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { parse, type WordPart } from "unbash";
import { shellWords } from "./shell-words.ts";
import { highlightDoubleQuotedSource } from "./quoted-source.ts";
import type { ScriptFormatterProfile } from "../../../settings-input.ts";

export type ScriptPreviewHeaderLayout = "auto" | "inline" | "block";

type ScriptPreview = {
    readonly code: string;
};

const MAX_COLLAPSED_SCRIPT_PREVIEW_BYTES = 64 * 1024;

function shellCommand(theme: GlowupRenderTheme, text: string): string {
    return theme.fg("syntaxFunction", text);
}

function shellText(theme: GlowupRenderTheme, text: string): string {
    if (text.length === 0) {
        return "";
    }

    return theme.fg("toolTitle", text);
}

function shellOperator(theme: GlowupRenderTheme, text: string): string {
    return theme.fg("syntaxOperator", text);
}

function shellFlag(theme: GlowupRenderTheme, text: string): string {
    return theme.fg("syntaxKeyword", text);
}

function shellKeyword(theme: GlowupRenderTheme, text: string): string {
    return theme.fg("syntaxKeyword", text);
}

function shellString(theme: GlowupRenderTheme, text: string): string {
    return theme.fg("syntaxString", text);
}

type ShellCommandKind = "generic" | "interpreter" | "script" | "subcommands";

type ShellHighlightState = {
    readonly expectsCommand: boolean;
    readonly expectsRedirectTarget: boolean;
    readonly expectingFlagValue: boolean;
    readonly commandKind: ShellCommandKind;
    readonly sawScriptOperand: boolean;
    readonly subcommandSeen: boolean;
};

type ShellTokenStyleResult = {
    readonly styled: string;
    readonly state: ShellHighlightState;
};

const SUBCOMMAND_SHELL_COMMANDS = new Set([
    "apt",
    "brew",
    "cargo",
    "docker",
    "dnf",
    "gh",
    "git",
    "go",
    "kubectl",
    "npm",
    "pnpm",
    "systemctl",
    "tmux",
    "yarn",
]);

const INTERPRETER_SHELL_COMMANDS = new Set([
    "bun",
    "deno",
    "node",
    "python",
    "python2",
    "python3",
    "ruby",
    "tsx",
]);

const WRAPPER_SHELL_COMMANDS = new Set(["command", "doas", "env", "exec", "sudo", "time"]);

const SHELL_RESERVED_WORDS = new Set([
    "case",
    "coproc",
    "do",
    "done",
    "elif",
    "else",
    "esac",
    "fi",
    "for",
    "function",
    "if",
    "in",
    "select",
    "then",
    "time",
    "until",
    "while",
]);

const SHELL_KEYWORDS_EXPECTING_COMMAND = new Set([
    "coproc",
    "do",
    "elif",
    "else",
    "function",
    "if",
    "then",
    "time",
    "until",
    "while",
]);

const BOOLEAN_LONG_FLAGS = new Set([
    "all",
    "dry-run",
    "force",
    "help",
    "json",
    "quiet",
    "verbose",
    "version",
    "yes",
]);

const VALUE_SHORT_FLAGS = new Set(["c", "C", "f", "I", "m", "n", "o", "p", "t", "u"]);

const VALUE_SINGLE_DASH_LONG_FLAGS = new Set([
    "depth",
    "exec",
    "group",
    "maxdepth",
    "mindepth",
    "mtime",
    "name",
    "path",
    "size",
    "type",
    "user",
]);

const initialShellHighlightState: ShellHighlightState = {
    expectsCommand: true,
    expectsRedirectTarget: false,
    expectingFlagValue: false,
    commandKind: "generic",
    sawScriptOperand: false,
    subcommandSeen: false,
};

type BashHeredocHighlight = {
    readonly marker: string;
    readonly language: string;
};

function bashHeredocHighlightFromLine(line: string): BashHeredocHighlight | undefined {
    const match = /<<-?\s*["']?(?<marker>[A-Za-z_][A-Za-z0-9_]*)["']?/u.exec(line);
    const marker = match?.groups?.marker;
    if (match === null || marker === undefined) {
        return undefined;
    }

    const suffix = line.slice(match.index + match[0].length);
    const pipeMatch = /^\s*\|\s*(?<pipedCmd>.+)$/u.exec(suffix);
    let interpreter: ReturnType<typeof detectHeredocInterpreter>;
    if (pipeMatch?.groups?.pipedCmd !== undefined) {
        interpreter = detectScriptInterpreter(pipeMatch.groups.pipedCmd);
    }
    interpreter ??= detectHeredocInterpreter(line.slice(0, match.index));
    if (interpreter === undefined) {
        return undefined;
    }

    return { marker, language: interpreter.language };
}

function highlightShellLine(theme: GlowupRenderTheme, line: string): string {
    const commentStart = shellCommentStart(line);
    const shellPart = commentStart === undefined ? line : line.slice(0, commentStart);
    const commentPart = commentStart === undefined ? "" : line.slice(commentStart);
    let state = initialShellHighlightState;
    const highlightedShell = tokenizeShellLine(shellPart)
        .map((token) => {
            const result = styleShellToken(theme, token, state);
            state = result.state;
            return result.styled;
        })
        .join("");

    return `${highlightedShell}${commentPart.length === 0 ? "" : dim(theme, commentPart)}`;
}

type EmbeddedInlineHighlightRow = {
    readonly start: number;
    readonly end: number;
    readonly highlighted: string;
};

function embeddedInlineHighlightRows(
    lines: ReadonlyArray<string>,
    theme: GlowupRenderTheme,
    invalidate: (() => void) | undefined,
): ReadonlyMap<number, ReadonlyArray<EmbeddedInlineHighlightRow>> {
    const source = lines.join("\n");
    const scripts = embeddedInlineScripts(source);
    if (scripts.length === 0) return new Map();

    const lineStarts: number[] = [0];
    for (let index = 0; index < source.length; index += 1) {
        if (source[index] === "\n") lineStarts.push(index + 1);
    }

    const rows = new Map<number, EmbeddedInlineHighlightRow[]>();
    for (const script of scripts) {
        const code = source.slice(script.start, script.end);
        let highlightedLines: string[];
        if (script.language === "bash") {
            const highlight = (source: string): string[] =>
                highlightBashScriptPreviewLines(source.split("\n"), theme, invalidate);
            if (source[script.start - 1] === '"') {
                highlightedLines = highlightDoubleQuotedSource(code, highlight);
            } else {
                highlightedLines = highlight(code);
            }
        } else {
            highlightedLines = highlightSyntaxCode(code, script.language, { invalidate });
        }

        let absoluteStart = script.start;
        for (const highlighted of highlightedLines) {
            let lineIndex = 0;
            while (
                lineIndex + 1 < lineStarts.length &&
                (lineStarts[lineIndex + 1] ?? Number.POSITIVE_INFINITY) <= absoluteStart
            ) {
                lineIndex += 1;
            }

            const lineStart = lineStarts[lineIndex];
            if (lineStart === undefined) break;

            const newline = source.indexOf("\n", absoluteStart);
            const absoluteEnd = newline < 0 || newline > script.end ? script.end : newline;
            const lineRows = rows.get(lineIndex) ?? [];
            lineRows.push({
                start: absoluteStart - lineStart,
                end: absoluteEnd - lineStart,
                highlighted,
            });
            rows.set(lineIndex, lineRows);
            absoluteStart = absoluteEnd + 1;
        }
    }

    return rows;
}

function highlightShellLineWithEmbeddedCode(
    theme: GlowupRenderTheme,
    line: string,
    rows: ReadonlyArray<EmbeddedInlineHighlightRow> | undefined,
): string {
    if (rows === undefined || rows.length === 0) return highlightShellLine(theme, line);

    const highlighted: string[] = [];
    let cursor = 0;
    for (const row of rows) {
        highlighted.push(highlightShellLine(theme, line.slice(cursor, row.start)));
        highlighted.push(row.highlighted);
        cursor = row.end;
    }

    highlighted.push(highlightShellLine(theme, line.slice(cursor)));

    return highlighted.join("");
}

function highlightBashScriptPreviewLines(
    lines: ReadonlyArray<string>,
    theme: GlowupRenderTheme,
    invalidate: (() => void) | undefined,
): string[] {
    const highlighted: string[] = [];
    const embeddedRows = embeddedInlineHighlightRows(lines, theme, invalidate);
    let heredoc: BashHeredocHighlight | undefined;
    let heredocBody: string[] = [];

    function flushHeredocBody(): void {
        if (heredoc === undefined || heredocBody.length === 0) {
            return;
        }

        highlighted.push(
            ...highlightSyntaxCode(heredocBody.join("\n"), heredoc.language, { invalidate }),
        );
        heredocBody = [];
    }

    for (const [lineIndex, line] of lines.entries()) {
        if (isPreviewMetaLine(line)) {
            flushHeredocBody();
            highlighted.push(line);
            continue;
        }

        if (heredoc !== undefined) {
            if (line.trim() === heredoc.marker) {
                flushHeredocBody();
                highlighted.push(highlightShellLine(theme, line));
                heredoc = undefined;
                continue;
            }

            heredocBody.push(line);
            continue;
        }

        highlighted.push(
            highlightShellLineWithEmbeddedCode(theme, line, embeddedRows.get(lineIndex)),
        );
        heredoc = bashHeredocHighlightFromLine(line);
    }

    flushHeredocBody();

    return highlighted;
}

function highlightScriptPreviewLines(
    lines: ReadonlyArray<string>,
    language: string,
    theme: GlowupRenderTheme,
    invalidate: (() => void) | undefined,
): string[] {
    if (language === "bash") {
        return highlightBashScriptPreviewLines(lines, theme, invalidate);
    }

    return [
        ...highlightCodePreviewRuns(lines, (code) =>
            highlightSyntaxCode(code, language, { invalidate }),
        ),
    ];
}

function scriptPreviewSyntaxLanguages(invocation: ScriptInvocation): readonly string[] {
    const languages = new Set<string>([invocation.language]);
    if (invocation.language !== "bash") {
        return [...languages];
    }

    for (const line of invocation.code.split("\n")) {
        const heredoc = bashHeredocHighlightFromLine(line);
        if (heredoc !== undefined) {
            languages.add(heredoc.language);
        }
    }

    for (const script of embeddedInlineScripts(invocation.code)) {
        languages.add(script.language);
    }

    return [...languages];
}

function scheduleScriptPreviewSyntaxLoads(
    invocation: ScriptInvocation,
    invalidate: (() => void) | undefined,
): void {
    for (const language of scriptPreviewSyntaxLanguages(invocation)) {
        scheduleCodeOutputSyntaxLoad(
            { language },
            invalidate,
            language === invocation.language ? invocation.code : undefined,
        );
    }
}

function collapsedScriptPreview(
    invocation: ScriptInvocation,
    maxCodePreviewLines: number,
    showPrologueOmission: boolean,
    profile?: ScriptFormatterProfile,
): ScriptPreview {
    if (profile?.kind === "bash") return { code: invocation.code };

    if (profile !== undefined && profile.kind !== "command") {
        if (profile.imports === "show") return { code: invocation.code };

        maxCodePreviewLines = 0;
    }

    if (trimEdgeBlankLines(invocation.code.split("\n")).length <= maxCodePreviewLines) {
        return { code: invocation.code };
    }

    const omission = omitLeadingImportPrologue(
        invocation.code,
        invocation.language,
        maxCodePreviewLines,
    );
    if (omission === undefined) return { code: invocation.code };

    return {
        code: showPrologueOmission
            ? `… ${omission.omittedLines} import/setup lines omitted\n${omission.code}`
            : omission.code,
    };
}

function scriptPreviewForRender(
    invocation: ScriptInvocation,
    expanded: boolean,
    maxCodePreviewLines: number,
    showPrologueOmission: boolean,
    profile?: ScriptFormatterProfile,
): ScriptPreview {
    if (expanded) {
        return { code: invocation.code };
    }

    return collapsedScriptPreview(invocation, maxCodePreviewLines, showPrologueOmission, profile);
}

function retainedScriptInvocation(
    invocation: ScriptInvocation,
    expanded: boolean,
    maxCodePreviewLines: number,
    showPrologueOmission: boolean,
    profile?: ScriptFormatterProfile,
): ScriptInvocation {
    if (expanded) {
        return invocation;
    }

    return {
        label: invocation.label,
        language: invocation.language,
        code: detachedScriptPreviewCode(
            collapsedScriptPreview(invocation, maxCodePreviewLines, showPrologueOmission, profile)
                .code,
        ),
    };
}

function detachedScriptPreviewCode(code: string): string {
    if (Buffer.byteLength(code, "utf8") <= MAX_COLLAPSED_SCRIPT_PREVIEW_BYTES) {
        return detachString(code);
    }

    const suffix = "\n… script preview truncated";
    const budget = Math.max(
        0,
        MAX_COLLAPSED_SCRIPT_PREVIEW_BYTES - Buffer.byteLength(suffix, "utf8"),
    );
    return detachString(`${truncateUtf8ByGrapheme(code, budget)}${suffix}`);
}

function wrapScriptLine(
    theme: GlowupRenderTheme,
    line: string,
    width: number,
    firstPrefix: string,
): string[] {
    return wrapSinglePhysicalLineWithContinuation(line, width, firstPrefix, dim(theme, "  │   "));
}

function renderScriptHeader(
    theme: GlowupRenderTheme,
    state: GlowupCallState,
    label: string,
): string {
    return `${renderBullet(theme, state)} ${actionText(theme, label, { bold: true })}`;
}

function scriptHasMultiplePhysicalLines(code: string): boolean {
    const normalized = code.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return trimEdgeBlankLines(normalized.split("\n")).length > 1;
}

function resolveScriptHeaderLayout(
    layout: ScriptPreviewHeaderLayout,
    invocation: ScriptInvocation,
    codeLines: ReadonlyArray<string>,
): Exclude<ScriptPreviewHeaderLayout, "auto"> {
    if (layout !== "auto") {
        return layout;
    }

    if (scriptHasMultiplePhysicalLines(invocation.code)) {
        return "block";
    }

    const firstCodeLine = codeLines[0];
    if (firstCodeLine === undefined) {
        return "block";
    }

    return "inline";
}

export type ScriptCallRenderOptions = {
    readonly state: GlowupCallState;
    readonly expanded: boolean;
    readonly maxCodePreviewLines?: number;
    readonly showPrologueOmission?: boolean;
    readonly omittedHint?: string;
    readonly headerLayout?: ScriptPreviewHeaderLayout;
    readonly invalidate?: () => void;
    readonly lastComponent?: Component | undefined;
    readonly onContentWidth?: (contentWidth: number, renderWidth: number) => void;
    readonly profile?: ScriptFormatterProfile;
};

export function renderScriptCall(
    theme: GlowupRenderTheme,
    invocation: ScriptInvocation,
    options: ScriptCallRenderOptions,
): Component {
    const { lastComponent, ...renderOptions } = options;

    return createSyntaxComponent(lastComponent, renderOptions.invalidate, (invalidate) =>
        createScriptCallComponent(theme, invocation, { ...renderOptions, invalidate }),
    );
}

function createScriptCallComponent(
    theme: GlowupRenderTheme,
    invocation: ScriptInvocation,
    options: Omit<ScriptCallRenderOptions, "lastComponent">,
): Component {
    const expanded = options.expanded;
    const state = options.state;
    const maxCodePreviewLines = options.maxCodePreviewLines ?? 8;
    const showPrologueOmission = options.showPrologueOmission ?? false;
    const retained = retainedScriptInvocation(
        invocation,
        expanded,
        maxCodePreviewLines,
        showPrologueOmission,
        options.profile,
    );
    const omittedHint = options.omittedHint ?? toolExpandHint();
    const headerLayoutOption = options.headerLayout ?? "auto";

    scheduleScriptPreviewSyntaxLoads(retained, options.invalidate);

    return makeComponent((width) => {
        const header = renderScriptHeader(theme, state, retained.label);
        const preview = scriptPreviewForRender(
            retained,
            expanded,
            maxCodePreviewLines,
            showPrologueOmission,
            options.profile,
        );

        if (preview.code.length === 0) {
            return wrapPrefixedLine("", width, header, "  ");
        }

        let fullLines = preview.code.split("\n");
        if (!expanded || options.profile === undefined) {
            fullLines = trimEdgeBlankLines(fullLines);
        }

        const fullHighlighted = highlightScriptPreviewLines(
            fullLines,
            retained.language,
            theme,
            options.invalidate,
        );
        const collapsedPreview = expanded
            ? undefined
            : collapsedPreviewLinesFromText(
                  fullHighlighted.join("\n"),
                  maxCodePreviewLines,
                  "head",
                  omittedHint,
              );
        const highlighted =
            collapsedPreview?.isEmpty === true
                ? [""]
                : collapsedPreview === undefined
                  ? fullHighlighted
                  : collapsedPreview.lines;
        const rendered: string[] = [];
        const headerLayout = resolveScriptHeaderLayout(headerLayoutOption, retained, highlighted);
        let prefixWidth = 4;
        if (headerLayout === "inline") prefixWidth = visibleWidth(`${header} `);
        options.onContentWidth?.(Math.max(1, width - Math.max(prefixWidth, 6)), width);

        if (headerLayout === "block") {
            rendered.push(...wrapPrefixedLine("", width, header, "  "));
        }

        const wrappedLines = highlighted.map((line, index) => {
            const meta = isPreviewMetaLine(line);
            const styled = meta ? muted(theme, line) : line;
            const firstPrefix =
                headerLayout === "inline" && index === 0 ? `${header} ` : dim(theme, "  │ ");
            return { meta, wrapped: wrapScriptLine(theme, styled, width, firstPrefix) };
        });
        const hasTailOmission = highlighted.some(
            (line) => isPreviewMetaLine(line) && !line.includes("import/setup lines omitted"),
        );
        const totalContentRows = wrappedLines
            .filter((line) => !line.meta)
            .reduce((rows, line) => rows + line.wrapped.length, 0);
        if (expanded || (!hasTailOmission && totalContentRows <= maxCodePreviewLines + 1)) {
            return [...rendered, ...wrappedLines.flatMap((line) => line.wrapped)];
        }

        let contentRows = 0;
        let softWrapTruncated = false;
        for (const { meta, wrapped } of wrappedLines) {
            if (meta) {
                rendered.push(...wrapped);
                continue;
            }

            const remainingRows = Math.max(0, maxCodePreviewLines - contentRows);
            if (wrapped.length <= remainingRows) {
                rendered.push(...wrapped);
                contentRows += wrapped.length;
                continue;
            }

            rendered.push(...wrapped.slice(0, remainingRows));
            softWrapTruncated = true;
            break;
        }

        if (softWrapTruncated) {
            rendered.push(
                ...wrapScriptLine(
                    theme,
                    muted(theme, "… preview truncated"),
                    width,
                    dim(theme, "  │ "),
                ),
            );
        }

        return rendered;
    });
}

function tokenizeShellLine(line: string): string[] {
    if (line.length === 0) {
        return [];
    }

    const gapTokens = (text: string): string[] =>
        text.match(
            /(?:\d+)?(?:<<-|<<<|<<|>>|<>|<&|>&|>\||[<>])|&>>|&>|&&|\|\||\[\[|\]\]|[|;&{}!]|\s+|[^\s|;&<>{}!]+/gu,
        ) ?? [];

    const tokens: string[] = [];
    let cursor = 0;
    for (const word of shellWords(line)) {
        if (word.pos < cursor) continue;
        tokens.push(...gapTokens(line.slice(cursor, word.pos)), word.text);
        cursor = word.end;
    }

    tokens.push(...gapTokens(line.slice(cursor)));

    return tokens;
}

function shellCommentStart(line: string): number | undefined {
    let quote: '"' | "'" | undefined;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];

        if (escaped) {
            escaped = false;
            continue;
        }

        if (char === "\\" && quote !== "'") {
            escaped = true;
            continue;
        }

        if (quote !== undefined) {
            if (char === quote) {
                quote = undefined;
            }
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }

        if (char === "#" && (index === 0 || /\s/.test(line[index - 1] ?? ""))) {
            return index;
        }
    }

    return undefined;
}

function shellCommandName(token: string): string {
    const normalized = token.replace(/^.*\//u, "");
    return normalized.toLowerCase();
}

function shellCommandKind(token: string): ShellCommandKind {
    const commandName = shellCommandName(token);
    if (INTERPRETER_SHELL_COMMANDS.has(commandName)) {
        return "interpreter";
    }

    if (SUBCOMMAND_SHELL_COMMANDS.has(commandName)) {
        return "subcommands";
    }

    if (isScriptLikeShellWord(token)) {
        return "script";
    }

    return "generic";
}

function isShellWrapperCommand(token: string): boolean {
    return WRAPPER_SHELL_COMMANDS.has(shellCommandName(token));
}

function isQuotedShellString(token: string): boolean {
    return (
        (token.startsWith('"') && token.endsWith('"')) ||
        (token.startsWith("'") && token.endsWith("'"))
    );
}

function isScriptLikeShellWord(token: string): boolean {
    return /\.(?:cjs|cts|js|jsx|mjs|mts|py|rb|sh|ts|tsx)$/iu.test(token);
}

function isPathLikeShellWord(token: string): boolean {
    return (
        token === "." ||
        token === ".." ||
        token.startsWith("/") ||
        token.startsWith("./") ||
        token.startsWith("../") ||
        token.startsWith("~/") ||
        token.includes("/") ||
        /^[^\s:]+:.+\//u.test(token) ||
        /\.(?:cjs|conf|cts|env|js|json|jsx|lock|log|md|mjs|mts|py|rb|sh|toml|ts|tsx|txt|yaml|yml)$/iu.test(
            token,
        )
    );
}

function isShellFlagToken(token: string): boolean {
    return /^--[A-Za-z0-9][\w-]*(?:=.*)?$/u.test(token) || /^-[A-Za-z0-9][\w-]*$/u.test(token);
}

function styleShellFlagToken(theme: GlowupRenderTheme, token: string): string {
    const equalsIndex = token.indexOf("=");
    if (token.startsWith("--") && equalsIndex > 2) {
        const value = token.slice(equalsIndex + 1);
        return `${shellFlag(theme, token.slice(0, equalsIndex))}${shellOperator(theme, "=")}${shellValue(theme, value)}`;
    }

    return shellFlag(theme, token);
}

function shellPart(theme: GlowupRenderTheme, part: WordPart, quoted: boolean): string {
    switch (part.type) {
        case "SingleQuoted":
        case "AnsiCQuoted":
            return shellString(theme, part.text);
        case "DoubleQuoted":
        case "LocaleString": {
            let openingLength = 1;
            if (part.type === "LocaleString") openingLength = 2;

            const childrenLength = part.parts.reduce(
                (length, child) => length + child.text.length,
                0,
            );

            return `${shellString(theme, part.text.slice(0, openingLength))}${part.parts.map((child) => shellPart(theme, child, true)).join("")}${shellString(theme, part.text.slice(openingLength + childrenLength))}`;
        }
        case "SimpleExpansion":
        case "ParameterExpansion":
        case "CommandExpansion":
        case "ArithmeticExpansion":
            return theme.fg("syntaxVariable", part.text);
        case "BraceExpansion":
        case "ExtendedGlob":
        case "Literal":
        case "ProcessSubstitution":
            break;
    }

    if (quoted) return shellString(theme, part.text);
    return shellText(theme, part.text);
}

function shellValue(theme: GlowupRenderTheme, token: string): string {
    try {
        const command = parse(`: ${token}`).commands[0]?.command;
        if (command?.type === "Command") {
            const parts = command.suffix[0]?.parts;
            if (parts !== undefined)
                return parts.map((part) => shellPart(theme, part, false)).join("");
        }
    } catch {
        return shellText(theme, token);
    }

    return shellText(theme, token);
}

function shellFlagConsumesValue(token: string): boolean {
    if (token.includes("=")) {
        return false;
    }

    const longFlag = /^--(?<name>[A-Za-z0-9][\w-]*)$/u.exec(token)?.groups?.name;
    if (longFlag !== undefined) {
        return !BOOLEAN_LONG_FLAGS.has(longFlag);
    }

    const singleDashLongFlag = /^-(?<name>[A-Za-z][\w-]{1,})$/u.exec(token)?.groups?.name;
    if (singleDashLongFlag !== undefined) {
        return VALUE_SINGLE_DASH_LONG_FLAGS.has(singleDashLongFlag);
    }

    const shortFlag = /^-(?<name>[A-Za-z])$/u.exec(token)?.groups?.name;
    return shortFlag !== undefined && VALUE_SHORT_FLAGS.has(shortFlag);
}

function shellStateAfterOperand(state: ShellHighlightState): ShellHighlightState {
    return {
        ...state,
        expectsCommand: false,
        expectingFlagValue: false,
        sawScriptOperand: state.sawScriptOperand || state.commandKind === "interpreter",
    };
}

function shouldStyleShellSubcommand(state: ShellHighlightState, token: string): boolean {
    if (state.subcommandSeen || isPathLikeShellWord(token) || isQuotedShellString(token)) {
        return false;
    }

    if (state.commandKind === "interpreter") {
        return state.sawScriptOperand;
    }

    return state.commandKind === "script" || state.commandKind === "subcommands";
}

function styleShellToken(
    theme: GlowupRenderTheme,
    token: string,
    state: ShellHighlightState,
): ShellTokenStyleResult {
    if (/^\s+$/.test(token)) {
        return { styled: token, state };
    }

    if (/^(?:\d+)?(?:<<-|<<<|<<|>>|<>|<&|>&|>\||[<>])$|^&>>?$/u.test(token)) {
        return {
            styled: shellOperator(theme, token),
            state: { ...state, expectsRedirectTarget: true },
        };
    }

    if (state.expectsRedirectTarget) {
        return {
            styled: shellValue(theme, token),
            state: { ...state, expectsRedirectTarget: false },
        };
    }

    if (["|", "||", "&&", "&", ";", "{", "}", "!", "[[", "]]"].includes(token)) {
        return { styled: shellOperator(theme, token), state: initialShellHighlightState };
    }

    if (SHELL_RESERVED_WORDS.has(token)) {
        return {
            styled: shellKeyword(theme, token),
            state: SHELL_KEYWORDS_EXPECTING_COMMAND.has(token)
                ? initialShellHighlightState
                : { ...initialShellHighlightState, expectsCommand: false },
        };
    }

    if (isShellFlagToken(token)) {
        return {
            styled: styleShellFlagToken(theme, token),
            state: {
                ...state,
                expectingFlagValue: shellFlagConsumesValue(token),
            },
        };
    }

    if (state.expectingFlagValue) {
        return {
            styled: shellValue(theme, token),
            state: shellStateAfterOperand(state),
        };
    }

    const assignment = /^(?<name>[A-Za-z_][A-Za-z0-9_]*)(?<operator>\+?=)/u.exec(token);
    if (assignment?.groups !== undefined) {
        return {
            styled: `${theme.fg("syntaxVariable", assignment.groups.name ?? "")}${shellOperator(theme, assignment.groups.operator ?? "")}${shellValue(theme, token.slice(assignment[0].length))}`,
            state,
        };
    }

    if (isQuotedShellString(token) || token.includes("$")) {
        return { styled: shellValue(theme, token), state: shellStateAfterOperand(state) };
    }

    if (state.expectsCommand) {
        if (isShellWrapperCommand(token)) {
            return { styled: shellCommand(theme, token), state: initialShellHighlightState };
        }

        return {
            styled: shellCommand(theme, token),
            state: {
                expectsCommand: false,
                expectsRedirectTarget: false,
                expectingFlagValue: false,
                commandKind: shellCommandKind(token),
                sawScriptOperand: false,
                subcommandSeen: false,
            },
        };
    }

    if (shouldStyleShellSubcommand(state, token)) {
        return {
            styled: shellCommand(theme, token),
            state: { ...state, expectingFlagValue: false, subcommandSeen: true },
        };
    }

    if (isPathLikeShellWord(token)) {
        return { styled: shellText(theme, token), state: shellStateAfterOperand(state) };
    }

    return { styled: shellText(theme, token), state: shellStateAfterOperand(state) };
}
