import { heredocScriptInterpreter } from "../../tools/built-in/bash/invocation.ts";
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
    let display = "";
    let consumed = 0;
    for (const literal of literals) {
        if (cancelled()) return source;

        const context = literal.heredoc;
        if (context === undefined || literal.delimiter === undefined || literal.start < consumed)
            continue;

        const interpreter = heredocScriptInterpreter(context.command);
        if (interpreter === undefined) continue;

        if (
            formatter.profileFor !== undefined &&
            formatter.profileFor(interpreter.language) === undefined
        )
            continue;

        const raw = source.slice(literal.start, context.bodyEnd);

        // An unquoted heredoc is shell-expanded before reaching the interpreter.
        // Never format a speculative source snapshot containing active expansions.
        if (!context.quoted && /[$`]|\\[$`\\\r\n]/u.test(raw)) continue;

        let code = raw;
        if (context.stripTabs) code = code.replace(/^\t+/gmu, "");
        if (code.trim().length === 0) continue;

        const parsed = await parser.parse(code, interpreter.language, true, signal);
        if (parsed === undefined || "error" in parsed || parsed.malformed || cancelled()) continue;

        const formatted = await formatCodeUnit(
            {
                key: "embedded-heredoc",
                source: code,
                language: interpreter.language,
                complete: true,
                mode: "block",
                formatter,
                targetWidth: input.targetWidth ?? options.targetWidth,
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
        if (formatted.applied !== true || cancelled()) continue;

        const collision = formatted.text.split(/\r?\n/u).some((line) => {
            let candidate = line;
            if (context.stripTabs) candidate = candidate.replace(/^\t+/u, "");

            return candidate === literal.delimiter;
        });
        if (collision) continue;

        let newline = "\n";
        if (raw.endsWith("\r\n")) newline = "\r\n";
        display += source.slice(consumed, literal.start) + formatted.text + newline;
        consumed = context.bodyEnd;
    }

    if (cancelled() || consumed === 0) return source;
    return display + source.slice(consumed);
}
