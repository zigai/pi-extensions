import {
    type GlowupRenderTheme,
    dim,
    type GlowupCallState,
    renderShellPrompt,
    muted,
    red,
} from "../../../rendering/theme.ts";
import { formatCallDuration } from "./duration.ts";
import type { ScriptInvocation } from "./invocation.ts";
import {
    extractEmbeddedPrograms,
    sourceCharacterAt,
    type EmbeddedProgram,
    type SourceSpan,
} from "./embedded-programs.ts";
import type { EmbeddedProgramLookup } from "./embedded-service.ts";
import { graphemes, sgrSequenceEnd } from "../../../text-boundaries.ts";
import {
    highlightSyntaxCode,
    type SyntaxHighlightOptions,
} from "../../../rendering/syntax/highlighter.ts";
import { filePathText } from "../../../rendering/path.ts";
import { createSyntaxComponent } from "../../../rendering/syntax/component-owner.ts";
import {
    isPreviewMetaLine,
    trimEdgeBlankLines,
    collapsedPreviewLinesFromText,
} from "../../../rendering/output.ts";
import { scheduleCodeOutputSyntaxLoad } from "../../../rendering/syntax/code-component.ts";
import { omitLeadingImportPrologue } from "./prologue.ts";
import {
    wrapSinglePhysicalLineWithContinuation,
    toolExpandHint,
    makeComponent,
} from "../../../rendering/component.ts";
import {
    type Component,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { parse, type WordPart } from "unbash";
import { shellWords } from "./shell-words.ts";
import type { ScriptFormatterProfile } from "../../../settings-input.ts";
import { recordRenderError } from "../../../diagnostics/render-events.ts";

type ScriptPreview = {
    readonly code: string;
    readonly omittedLines?: number;
    readonly omissionMarker?: string;
};

const sourceOwners = new WeakMap<() => void, object>();

type ChildOwners = {
    readonly logicalSource: string;
    readonly parentSignal: AbortSignal | undefined;
    readonly controller: AbortController;
    readonly signal: AbortSignal;
    readonly children: Map<string, SyntaxHighlightOptions>;
};

const childOwners = new WeakMap<() => void, ChildOwners>();

function childHighlightOptions(
    invalidate: (() => void) | undefined,
    logicalSource: string,
    parentSignal: AbortSignal | undefined,
): (key: string) => SyntaxHighlightOptions {
    if (invalidate === undefined) {
        if (parentSignal === undefined) return () => ({});
        return () => ({ signal: parentSignal });
    }

    let owner = childOwners.get(invalidate);
    if (
        owner === undefined ||
        owner.logicalSource !== logicalSource ||
        owner.parentSignal !== parentSignal
    ) {
        owner?.controller.abort();

        const controller = new AbortController();
        let signal = controller.signal;
        if (parentSignal !== undefined) signal = AbortSignal.any([signal, parentSignal]);
        owner = { logicalSource, parentSignal, controller, signal, children: new Map() };
        childOwners.set(invalidate, owner);
    }

    const current = owner;
    return (key) => {
        let child = current.children.get(key);
        if (child === undefined) {
            child = {
                signal: current.signal,
                invalidate: () => {
                    if (childOwners.get(invalidate) === current && !current.signal.aborted)
                        invalidate();
                },
            };
            current.children.set(key, child);
        }

        return child;
    };
}

function programKey(program: EmbeddedProgram): string {
    const path: Array<[number, number, string, string]> = [];
    let current: EmbeddedProgram | undefined = program;
    while (current !== undefined) {
        path.push([current.start, current.end, current.language, current.origin]);
        current = current.parent;
    }

    return JSON.stringify(path);
}

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

function projectLinearHighlight(
    source: string,
    code: string,
    highlighted: string,
    span: SourceSpan,
    start: number,
    end: number,
): string | undefined {
    let result = "";
    let pending = "";
    let cursor = start;
    let index = 0;
    let codeIndex = 0;
    while (index < highlighted.length) {
        const sgrEnd = sgrSequenceEnd(highlighted, index);
        if (sgrEnd !== undefined) {
            pending += highlighted.slice(index, sgrEnd);
            index = sgrEnd;
            continue;
        }

        let next = highlighted.indexOf("\u001b", index + 1);
        while (next >= 0 && sgrSequenceEnd(highlighted, next) === undefined)
            next = highlighted.indexOf("\u001b", next + 1);

        if (next < 0) next = highlighted.length;

        const text = highlighted.slice(index, next);
        if (!code.startsWith(text, codeIndex)) return undefined;

        const rawStart = span.start + codeIndex;
        if (rawStart >= source.length) return result + pending;

        const length = Math.min(text.length, source.length - rawStart);
        result +=
            source.slice(cursor, rawStart) + pending + source.slice(rawStart, rawStart + length);
        pending = "";
        cursor = rawStart + length;
        codeIndex += length;

        if (length < text.length) return result;

        index = next;
    }

    if (end <= source.length && codeIndex !== code.length && code.slice(codeIndex) !== "\n")
        return undefined;

    return result + pending + source.slice(cursor, end);
}

function projectHighlightedSource(
    source: string,
    program: EmbeddedProgram,
    highlighted: string,
    parent: EmbeddedProgram | undefined,
): string | undefined {
    let characters = program.characters;
    let start = program.start;
    let endPosition = program.end;
    if (parent !== undefined) {
        characters = program.localCharacters;
        start = program.localStart;
        endPosition = program.localEnd;
    }

    if (characters === undefined || (characters.at(-1)?.to ?? 0) !== program.code.length)
        return undefined;

    const span = characters[0];
    if (
        characters.length === 1 &&
        span?.from === 0 &&
        span.to === program.code.length &&
        span.end - span.start === program.code.length &&
        !program.code.includes("\r")
    )
        return projectLinearHighlight(source, program.code, highlighted, span, start, endPosition);

    let result = "";
    let pending = "";
    let cursor = start;
    let codeIndex = 0;
    for (let index = 0; index < highlighted.length; index++) {
        const end = sgrSequenceEnd(highlighted, index);
        if (end !== undefined) {
            pending += highlighted.slice(index, end);
            index = end - 1;
            continue;
        }

        let consumed = 1;
        if (highlighted[index] === "\n" && program.code[codeIndex] === "\r") {
            if (program.code[codeIndex + 1] === "\n") consumed = 2;
        } else if (highlighted[index] !== program.code[codeIndex]) return undefined;

        const character = sourceCharacterAt(characters, codeIndex);
        const last = sourceCharacterAt(characters, codeIndex + consumed - 1);

        codeIndex += consumed;

        if (character === undefined || last === undefined) return undefined;
        if (character.start >= source.length) return result + pending;

        if (last.end > cursor) {
            result +=
                source.slice(cursor, character.start) +
                pending +
                source.slice(Math.max(cursor, character.start), last.end);
            pending = "";
            cursor = last.end;
        }
    }

    if (
        endPosition <= source.length &&
        codeIndex !== program.code.length &&
        !["\n", "\r", "\r\n"].includes(program.code.slice(codeIndex))
    )
        return undefined;

    return result + pending + source.slice(cursor, endPosition);
}

type EmbeddedInlineHighlightRow = {
    readonly start: number;
    readonly end: number;
    readonly highlighted: string;
};

function embeddedInlineHighlightRows(
    lines: ReadonlyArray<string>,
    theme: GlowupRenderTheme,
    programs: readonly EmbeddedProgram[],
    parent: EmbeddedProgram | undefined,
    childOptions: (key: string) => SyntaxHighlightOptions,
): ReadonlyMap<number, ReadonlyArray<EmbeddedInlineHighlightRow>> {
    const source = lines.join("\n");
    const scripts = programs.filter((program) => program.parent === parent && !program.expandable);
    if (scripts.length === 0) return new Map();

    const lineStarts: number[] = [0];
    for (let index = 0; index < source.length; index += 1) {
        if (source[index] === "\n") lineStarts.push(index + 1);
    }

    const rows = new Map<number, EmbeddedInlineHighlightRow[]>();
    for (const script of scripts) {
        let start = script.start;
        let end = script.end;
        if (parent !== undefined) {
            start = script.localStart;
            end = script.localEnd;
        }

        if (start >= source.length) continue;

        let decoded: string[];
        if (script.language === "bash") {
            let code = script.code;
            let characters = script.characters;
            if (parent !== undefined) characters = script.localCharacters;

            if (end > source.length && characters !== undefined) {
                let low = 0;
                let high = code.length;
                while (low < high) {
                    const middle = Math.floor((low + high) / 2);
                    const character = sourceCharacterAt(characters, middle);
                    if (character === undefined || character.start >= source.length) high = middle;
                    else low = middle + 1;
                }

                code = code.slice(0, low);
            }

            decoded = highlightBashScriptPreviewLines(
                code.split("\n"),
                theme,
                programs,
                script,
                childOptions,
            );
        } else
            decoded = highlightSyntaxCode(
                script.code,
                script.language,
                childOptions(programKey(script)),
            );

        let projected: string | undefined;
        const raw = source.slice(start, end);
        if (script.language === "bash" && raw === script.code) projected = decoded.join("\n");
        else if (
            script.language === "bash" &&
            raw.length >= 2 &&
            raw.slice(1, -1) === script.code &&
            (raw.startsWith("'") || raw.startsWith('"'))
        )
            projected = raw[0] + decoded.join("\n") + raw.at(-1);
        else projected = projectHighlightedSource(source, script, decoded.join("\n"), parent);

        if (projected === undefined) continue;

        const highlightedLines = wrapTextWithAnsi(projected, Number.POSITIVE_INFINITY);
        let absoluteStart = start;
        let lineIndex = 0;

        for (const highlighted of highlightedLines) {
            if (absoluteStart >= end) break;

            while (
                lineIndex + 1 < lineStarts.length &&
                (lineStarts[lineIndex + 1] ?? Number.POSITIVE_INFINITY) <= absoluteStart
            ) {
                lineIndex += 1;
            }

            const lineStart = lineStarts[lineIndex];
            if (lineStart === undefined) break;

            const newline = source.indexOf("\n", absoluteStart);
            const absoluteEnd = newline < 0 || newline > end ? end : newline;
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
    programs: readonly EmbeddedProgram[],
    parent: EmbeddedProgram | undefined,
    childOptions: (key: string) => SyntaxHighlightOptions,
): string[] {
    const embeddedRows = embeddedInlineHighlightRows(lines, theme, programs, parent, childOptions);

    return lines.map((line, lineIndex) => {
        if (isPreviewMetaLine(line)) return line;
        return highlightShellLineWithEmbeddedCode(theme, line, embeddedRows.get(lineIndex));
    });
}

function scheduleScriptPreviewSyntaxLoad(
    invocation: ScriptInvocation,
    invalidate: (() => void) | undefined,
): void {
    if (invocation.language === "bash") return;

    scheduleCodeOutputSyntaxLoad({ language: invocation.language }, invalidate, invocation.code);
}

function visibleBashPrefix(source: string, width: number, rows: number): string {
    let end = 0;
    let row = 0;
    let column = 0;
    const contentWidth = Math.max(1, width - 6);

    for (const character of graphemes(source)) {
        if (character === "\n" || character === "\r\n" || character === "\r") {
            row++;
            column = 0;
        } else {
            const cells = visibleWidth(character);
            if (column > 0 && column + cells > contentWidth) {
                row++;
                column = 0;
            }

            column += cells;
        }

        if (row > rows) break;

        end += character.length;
    }

    return source.slice(0, end);
}

function collapsedScriptPreview(
    invocation: ScriptInvocation,
    maxCodePreviewLines: number,
    showPrologueOmission: boolean,
    profile?: ScriptFormatterProfile,
): ScriptPreview {
    if (
        invocation.language === "bash" ||
        profile?.kind === "bash" ||
        profile?.kind === "awk" ||
        profile?.kind === "jq"
    )
        return { code: invocation.code };

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
        code: omission.code,
        omittedLines: omission.omittedLines,
        ...(showPrologueOmission && {
            omissionMarker: `… ${omission.omittedLines} import/setup lines omitted`,
        }),
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

function promptDuration(
    theme: GlowupRenderTheme,
    state: GlowupCallState,
    durationMs: number | undefined,
): string | undefined {
    if (state === "running") return undefined;

    const duration = formatCallDuration(durationMs);
    if (duration === undefined) return undefined;
    if (state === "error") return red(theme, duration);

    return muted(theme, duration);
}

function appendRightAligned(rows: string[], text: string | undefined, width: number): string[] {
    const first = rows[0];
    if (text === undefined || first === undefined) return rows;

    const padding = width - visibleWidth(first) - visibleWidth(text) - 1;
    if (padding < 1) return rows;

    return [`${first}${" ".repeat(padding)}${text} `, ...rows.slice(1)];
}

export type ScriptCallRenderOptions = {
    readonly state: GlowupCallState;
    readonly expanded: boolean;
    readonly maxCodePreviewLines?: number;
    readonly showPrologueOmission?: boolean;
    readonly omittedHint?: string;
    readonly invalidate?: () => void;
    readonly lastComponent?: Component | undefined;
    readonly onContentWidth?: (contentWidth: number, renderWidth: number) => void;
    readonly profile?: ScriptFormatterProfile;
    readonly embeddedPrograms?: EmbeddedProgramLookup;
    readonly logicalSource?: string;
    readonly signal?: AbortSignal;
    readonly durationMs?: number | undefined;
};

/** Renders a Bash call as a `$` prompt: the launcher (or first code line) beside `$`, code below. */
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

const PROMPT_LINE_PREFIX = "  ";
const PROMPT_CONTINUATION_PREFIX = "    ";
const MINIMUM_PROMPT_CODE_WIDTH = 12;

function createScriptCallComponent(
    theme: GlowupRenderTheme,
    invocation: ScriptInvocation,
    options: Omit<ScriptCallRenderOptions, "lastComponent">,
): Component {
    const expanded = options.expanded;
    const state = options.state;
    const maxCodePreviewLines = options.maxCodePreviewLines ?? 8;
    const showPrologueOmission = options.showPrologueOmission ?? false;
    const retained = invocation;
    const omittedHint = options.omittedHint ?? toolExpandHint();
    const childOptions = childHighlightOptions(
        options.invalidate,
        options.logicalSource ?? retained.code,
        options.signal,
    );
    let syntaxOptions: SyntaxHighlightOptions = {
        invalidate: options.invalidate,
        ...(options.signal !== undefined && { signal: options.signal }),
    };
    if (retained.language !== "bash") syntaxOptions = childOptions("standalone");

    const sourceOwner = {};
    if (options.invalidate !== undefined) sourceOwners.set(options.invalidate, sourceOwner);

    const schedulePrograms = (current: readonly EmbeddedProgram[]): void => {
        if (current.length === 0) return;

        let index = 0;
        const next = (): void => {
            if (options.signal?.aborted === true) return;
            if (
                options.invalidate !== undefined &&
                sourceOwners.get(options.invalidate) !== sourceOwner
            )
                return;
            if (
                options.embeddedPrograms?.isCurrent !== undefined &&
                !options.embeddedPrograms.isCurrent(retained.code, current)
            )
                return;

            const program = current[index++];
            if (program === undefined) return;

            if (!program.expandable)
                highlightSyntaxCode(
                    program.code,
                    program.language,
                    childOptions(programKey(program)),
                );

            if (index < current.length) setImmediate(next);
        };

        setImmediate(next);
    };

    let programs: readonly EmbeddedProgram[] = [];
    if (retained.language === "bash") {
        if (options.embeddedPrograms === undefined)
            programs = extractEmbeddedPrograms(retained.code);
        else programs = options.embeddedPrograms(retained.code, options.invalidate) ?? [];
    }

    scheduleScriptPreviewSyntaxLoad(retained, syntaxOptions.invalidate);
    schedulePrograms(programs);

    return makeComponent((width) => {
        if (retained.language === "bash" && options.embeddedPrograms !== undefined) {
            const available = options.embeddedPrograms(retained.code, options.invalidate);
            if (available !== undefined && available !== programs) {
                programs = available;
                scheduleScriptPreviewSyntaxLoad(retained, syntaxOptions.invalidate);
                schedulePrograms(programs);
            }
        }

        const promptPrefix = `${renderShellPrompt(theme)} `;
        let duration = promptDuration(theme, state, options.durationMs);
        let durationReserve = 0;
        if (duration !== undefined) durationReserve = visibleWidth(duration) + 2;

        if (width - durationReserve < MINIMUM_PROMPT_CODE_WIDTH) {
            duration = undefined;
            durationReserve = 0;
        }

        const rendered: string[] = [];
        if (retained.launcher !== undefined) {
            rendered.push(
                ...wrapSinglePhysicalLineWithContinuation(
                    highlightShellLine(theme, retained.launcher),
                    width - durationReserve,
                    promptPrefix,
                    PROMPT_CONTINUATION_PREFIX,
                ),
            );
        }

        const codeStartsOnPromptRow = retained.launcher === undefined;
        const preview = scriptPreviewForRender(
            retained,
            expanded,
            maxCodePreviewLines,
            showPrologueOmission,
            options.profile,
        );

        if (preview.code.length === 0) {
            if (codeStartsOnPromptRow) rendered.push(promptPrefix.trimEnd());

            return appendRightAligned(rendered, duration, width);
        }

        let visibleCode = preview.code;
        if (!expanded && retained.language === "bash")
            visibleCode = visibleBashPrefix(preview.code, width, maxCodePreviewLines);

        let viewClipped = visibleCode.length < preview.code.length;
        let fullLines = visibleCode.split("\n");
        let fullHighlighted: string[];
        if (retained.language === "bash") {
            fullHighlighted = highlightBashScriptPreviewLines(
                fullLines,
                theme,
                programs,
                undefined,
                childOptions,
            );
        } else {
            fullHighlighted = highlightSyntaxCode(
                retained.code,
                retained.language,
                syntaxOptions,
            ).slice(preview.omittedLines ?? 0);
        }

        if (preview.omissionMarker !== undefined) {
            fullLines = [preview.omissionMarker, ...fullLines];
            fullHighlighted = [preview.omissionMarker, ...fullHighlighted];
        }

        if (!expanded || options.profile === undefined) {
            let start = 0;
            let end = fullLines.length;
            while (start < end && (fullLines[start] ?? "").trim().length === 0) start++;
            while (end > start && (fullLines[end - 1] ?? "").trim().length === 0) end--;
            fullHighlighted = fullHighlighted.slice(start, end);
        }

        if (!expanded) {
            const columns = Math.max(1, width - 6) * (maxCodePreviewLines + 1);

            if (fullHighlighted.length > maxCodePreviewLines + 1) viewClipped = true;

            fullHighlighted = fullHighlighted.slice(0, maxCodePreviewLines + 1).map((line) => {
                const clipped = truncateToWidth(line, columns, "");
                if (clipped.length < line.length) viewClipped = true;
                return clipped;
            });
        }

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

        options.onContentWidth?.(
            Math.max(1, width - visibleWidth(PROMPT_CONTINUATION_PREFIX)),
            width,
        );

        const wrappedLines = highlighted.map((line, index) => {
            const meta = isPreviewMetaLine(line);
            const styled = meta ? muted(theme, line) : line;
            const onPromptRow = codeStartsOnPromptRow && index === 0;
            return {
                meta,
                wrapped: wrapSinglePhysicalLineWithContinuation(
                    styled,
                    onPromptRow ? width - durationReserve : width,
                    onPromptRow ? promptPrefix : PROMPT_LINE_PREFIX,
                    PROMPT_CONTINUATION_PREFIX,
                ),
            };
        });
        const hasTailOmission = highlighted.some(
            (line) => isPreviewMetaLine(line) && !line.includes("import/setup lines omitted"),
        );
        const totalContentRows = wrappedLines
            .filter((line) => !line.meta)
            .reduce((rows, line) => rows + line.wrapped.length, 0);
        if (
            expanded ||
            (!viewClipped && !hasTailOmission && totalContentRows <= maxCodePreviewLines + 1)
        ) {
            return appendRightAligned(
                [...rendered, ...wrappedLines.flatMap((line) => line.wrapped)],
                duration,
                width,
            );
        }

        let contentRows = 0;
        let shownLines = 0;
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
                shownLines++;
                continue;
            }

            rendered.push(...wrapped.slice(0, remainingRows));
            softWrapTruncated = remainingRows > 0;
            break;
        }

        if (softWrapTruncated || (viewClipped && !hasTailOmission)) {
            let marker = "… preview truncated";
            if (!softWrapTruncated) {
                let lines = 1;
                for (
                    let at = preview.code.indexOf("\n");
                    at >= 0;
                    at = preview.code.indexOf("\n", at + 1)
                )
                    lines++;

                const omitted = Math.max(0, lines - shownLines);
                if (omitted > 0) marker = `… +${omitted} lines (${omittedHint})`;
            }

            rendered.push(
                ...wrapSinglePhysicalLineWithContinuation(
                    muted(theme, marker),
                    width,
                    PROMPT_LINE_PREFIX,
                    PROMPT_CONTINUATION_PREFIX,
                ),
            );
        }

        return appendRightAligned(rendered, duration, width);
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
    if (/^[a-z][a-z\d+.-]*:\/\//iu.test(token) || /[\r\n]/u.test(token)) return false;

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
        case "SingleQuoted": {
            if (!part.text.endsWith("'")) return shellString(theme, part.text);

            const value = part.text.slice(1, -1);
            if (isPathLikeShellWord(value))
                return `${shellString(theme, "'")}${filePathText(theme, value)}${shellString(theme, "'")}`;

            return shellString(theme, part.text);
        }
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

    if (part.type === "Literal" && isPathLikeShellWord(part.text))
        return filePathText(theme, part.text);

    if (quoted) return shellString(theme, part.text);
    return shellText(theme, part.text);
}

function shellValue(theme: GlowupRenderTheme, token: string): string {
    // Plain words have no parsed parts; keep the same path styling as operands.
    if (!/["'`$\\]/u.test(token) && isPathLikeShellWord(token)) return filePathText(theme, token);

    try {
        const command = parse(`: ${token}`).commands[0]?.command;
        if (command?.type === "Command") {
            const parts = command.suffix[0]?.parts;
            if (parts !== undefined)
                return parts.map((part) => shellPart(theme, part, false)).join("");
        }
    } catch (cause: unknown) {
        recordRenderError("bash.highlight-shell-word", cause);
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

        let styled = shellCommand(theme, token);
        if (isPathLikeShellWord(token)) styled = filePathText(theme, token);

        return {
            styled,
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
        return { styled: filePathText(theme, token), state: shellStateAfterOperand(state) };
    }

    return { styled: shellText(theme, token), state: shellStateAfterOperand(state) };
}
