import {
    heredocScriptInterpreter,
    isFileWritingHeredocCommand,
} from "../../tools/built-in/bash/invocation.ts";
import {
    renderDiagnosticsEnabled,
    type ScriptSegmentDiagnostic,
} from "../../diagnostics/render-events.ts";
import type {
    ScriptBlockFormatter,
    ScriptBlockFormatterInput,
    ScriptBlockFormatterOptions,
} from "../../tools/built-in/bash/formatter.ts";
import { formatCodeUnit } from "./code-unit.ts";
import type { createStatementService } from "./statement-service.ts";
import type { StatementResponse } from "./statement-worker.ts";
import type { StatementLiteral } from "./statement-literals.ts";

type Parser = Pick<ReturnType<typeof createStatementService>, "parse">;

function literalsIn(response: StatementResponse | undefined): StatementLiteral[] {
    if (response === undefined || "error" in response) return [];

    const byStart = new Map<number, StatementLiteral>();
    for (const unit of response.units)
        for (const literal of unit.literals ?? []) byStart.set(literal.start, literal);

    return [...byStart.values()].sort((left, right) => left.start - right.start);
}

/** Keep the Bash transcript intact; replace only complete, confidently identified
 * source payloads. No shell evaluation, delimiter-name guesses, or input mutation. */
export async function formatEmbeddedHeredocs(
    input: ScriptBlockFormatterInput,
    formatter: ScriptBlockFormatter | undefined,
    parser: Parser,
    options: ScriptBlockFormatterOptions = {},
): Promise<string> {
    const source = input.code;
    if (formatter === undefined || !source.includes("<<") || options.signal?.aborted === true)
        return source;

    const signal = options.signal ?? new AbortController().signal;
    const cancelled = (): boolean => signal.aborted;
    const shell = await parser.parse(source, "bash", true, signal);
    const literals = literalsIn(shell);
    const context = options.diagnostics;
    const recordSegment = context?.recordSegment;
    const record = (segment: () => ScriptSegmentDiagnostic): void => {
        if (recordSegment !== undefined && renderDiagnosticsEnabled()) recordSegment(segment());
    };

    let display = "";
    let consumed = 0;

    for (const literal of literals) {
        if (cancelled()) return source;

        const heredoc = literal.heredoc;

        if (
            literal.kind !== "heredoc" ||
            literal.delimiter === undefined ||
            literal.start < consumed
        )
            continue;

        const unattached = (skipReason: string): ScriptSegmentDiagnostic => {
            // The literal ends after its closing delimiter line; report only the body.
            const withDelimiter = source.slice(literal.start, literal.end);
            const body = withDelimiter.slice(0, withDelimiter.lastIndexOf("\n") + 1);

            return {
                language: "text",
                origin: "heredoc",
                start: literal.start,
                end: literal.start + body.length,
                code: body,
                displayCode: body.replace(/\r?\n$/u, ""),
                formattable: false,
                skipReason,
            };
        };

        if (heredoc === undefined) {
            record(() => unattached("no-command-context"));
            continue;
        }

        const interpreter = heredocScriptInterpreter(heredoc.command);
        if (interpreter === undefined) {
            record(() => unattached("data-heredoc"));
            continue;
        }

        const raw = source.slice(literal.start, heredoc.bodyEnd);
        let code = raw;
        if (heredoc.stripTabs) code = code.replace(/^\t+/gmu, "");

        let origin: ScriptSegmentDiagnostic["origin"] = "heredoc";
        if (recordSegment !== undefined && isFileWritingHeredocCommand(heredoc.command))
            origin = "file-heredoc";

        const segment = (fields: {
            readonly formattable: boolean;
            readonly formatted?: boolean;
            readonly skipReason?: string;
        }): ScriptSegmentDiagnostic => ({
            language: interpreter.language,
            origin,
            start: literal.start,
            end: heredoc.bodyEnd,
            code,
            displayCode: raw.replace(/\r?\n$/u, ""),
            ...fields,
        });

        if (
            formatter.profileFor !== undefined &&
            formatter.profileFor(interpreter.language) === undefined
        ) {
            record(() => segment({ formattable: false, skipReason: "no-profile" }));
            continue;
        }

        // An unquoted heredoc is shell-expanded before reaching the interpreter.
        // Never format a speculative source snapshot containing active expansions.
        if (!heredoc.quoted && /[$`]|\\[$`\\\r\n]/u.test(raw)) {
            record(() => segment({ formattable: false, skipReason: "unquoted-expansion" }));
            continue;
        }

        if (code.trim().length === 0) {
            record(() => segment({ formattable: false, skipReason: "empty" }));
            continue;
        }

        const parsed = await parser.parse(code, interpreter.language, true, signal);

        if (cancelled()) return source;

        if (parsed === undefined || "error" in parsed) {
            record(() => segment({ formattable: false, skipReason: "parser-unavailable" }));
            continue;
        }

        if (parsed.malformed) {
            record(() => segment({ formattable: false, skipReason: "malformed" }));
            continue;
        }

        const formatted = await formatCodeUnit(
            {
                key: "embedded-heredoc",
                source: code,
                language: interpreter.language,
                complete: true,
                mode: "block",
                formatter,
                targetWidth: input.targetWidth ?? options.targetWidth,
                diagnostics: {
                    ...(context?.toolCallId !== undefined && { toolCallId: context.toolCallId }),
                    stage: "embedded-heredoc",
                    sourceCode: code,
                    segmentCode: code,
                },
            },
            interpreter.language,
            {
                start: 0,
                end: code.length,
                format: true,
                indent: "",
                kind: "block",
                literals: literalsIn(parsed),
            },
            signal,
            "",
        );

        if (cancelled()) return source;

        if (formatted.applied !== true) {
            record(() =>
                segment({ formattable: true, formatted: false, skipReason: "formatter-declined" }),
            );

            continue;
        }

        const collision = formatted.text.split(/\r?\n/u).some((line) => {
            let candidate = line;
            if (heredoc.stripTabs) candidate = candidate.replace(/^\t+/u, "");

            return candidate === literal.delimiter;
        });
        if (collision) {
            record(() =>
                segment({ formattable: true, formatted: false, skipReason: "delimiter-collision" }),
            );

            continue;
        }

        record(() => segment({ formattable: true, formatted: true }));

        let newline = "\n";
        if (raw.endsWith("\r\n")) newline = "\r\n";
        display += source.slice(consumed, literal.start) + formatted.text + newline;
        consumed = heredoc.bodyEnd;
    }

    if (cancelled() || consumed === 0) return source;
    return display + source.slice(consumed);
}
