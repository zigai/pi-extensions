import { visibleWidth } from "@earendil-works/pi-tui";
import type { EmbeddedProgram } from "../../tools/built-in/bash/embedded-programs.ts";
import { filterProgramSkipReason } from "../../tools/built-in/bash/filter-formatting.ts";
import type {
    ScriptBlockFormatter,
    ScriptBlockFormatterInput,
    ScriptBlockFormatterOptions,
} from "../../tools/built-in/bash/formatter.ts";
import {
    recordRenderError,
    renderDiagnosticsEnabled,
    type ScriptFormatStage,
    type ScriptSegmentDiagnostic,
} from "../../diagnostics/render-events.ts";
import { formatCodeUnit } from "./code-unit.ts";
import type { createStatementService } from "./statement-service.ts";
import type { StatementResponse } from "./statement-worker.ts";
import type { StatementLiteral } from "./statement-literals.ts";

type Parser = Pick<ReturnType<typeof createStatementService>, "parse">;
type Replacement = { readonly start: number; readonly end: number; readonly text: string };

function aborted(signal: AbortSignal): boolean {
    return signal.aborted;
}

function literalsIn(response: StatementResponse | undefined): StatementLiteral[] {
    if (response === undefined || "error" in response) return [];

    const literals = new Map<number, StatementLiteral>();
    for (const unit of response.units)
        for (const literal of unit.literals ?? []) literals.set(literal.start, literal);

    return [...literals.values()].sort((left, right) => left.start - right.start);
}

function replace(source: string, changes: readonly Replacement[]): string {
    let result = source;

    for (const change of [...changes].sort((a, b) => b.start - a.start))
        result = result.slice(0, change.start) + change.text + result.slice(change.end);

    return result;
}

function quotedWord(code: string): string {
    return `'${code.replace(/'/gu, "'\\''")}'`;
}

function depth(program: EmbeddedProgram): number {
    let level = 0;
    let parent = program.parent;
    while (parent !== undefined) {
        level++;
        parent = parent.parent;
    }

    return level;
}

export async function formatEmbeddedPrograms(
    input: ScriptBlockFormatterInput,
    formatter: ScriptBlockFormatter | undefined,
    parser: Parser,
    programs: readonly EmbeddedProgram[],
    options: ScriptBlockFormatterOptions = {},
): Promise<string> {
    if (formatter === undefined || options.signal?.aborted === true) return input.code;

    const signal = options.signal ?? new AbortController().signal;
    const changes = new Map<EmbeddedProgram | undefined, Replacement[]>();
    const recordSegment = options.diagnostics?.recordSegment;
    const record = (segment: () => ScriptSegmentDiagnostic): void => {
        if (recordSegment !== undefined && renderDiagnosticsEnabled()) recordSegment(segment());
    };

    for (const program of [...programs].sort(
        (left, right) => depth(right) - depth(left) || left.start - right.start,
    )) {
        if (signal.aborted) return input.code;

        const current = replace(program.code, changes.get(program) ?? []);
        let profile;
        let reason: string | undefined;
        if (program.splitString === true) reason = "unsupported-env-split";
        if (program.language === "sed") reason = "unsupported-language";

        let ancestor: EmbeddedProgram | undefined = program;
        while (ancestor !== undefined) {
            if (ancestor.incomplete) {
                reason = "incomplete-heredoc";
                break;
            }

            if (ancestor.expandable) {
                reason = "unquoted-expansion";
                break;
            }

            ancestor = ancestor.parent;
        }

        if (reason === undefined) {
            try {
                profile = formatter.profileFor?.(program.language);
            } catch (cause: unknown) {
                recordRenderError("bash.embedded-profile", cause);
                reason = "profile-error";
            }
        }

        if (reason === undefined && formatter.profileFor !== undefined && profile === undefined)
            reason = "no-profile";
        else if (reason === undefined && current.trim().length === 0) reason = "empty";

        const parentSource = program.parent?.code ?? input.code;
        const rowStart = parentSource.lastIndexOf("\n", program.localStart - 1) + 1;
        const base = /^[\t ]*/u.exec(parentSource.slice(rowStart))?.[0] ?? "";
        const width = input.targetWidth ?? options.targetWidth ?? 88;
        const layout = {
            width: Math.max(1, width - visibleWidth(base)),
            firstLineOffset: visibleWidth(
                parentSource.slice(rowStart + base.length, program.localStart + 1),
            ),
        };
        if (reason === undefined && (profile?.kind === "awk" || profile?.kind === "jq"))
            reason = filterProgramSkipReason(current, profile.kind, layout);

        let formatted: string | undefined;
        let stage: ScriptFormatStage = "embedded-heredoc";
        if (program.origin === "inline") {
            stage = "block";
            if (program.language === "awk" || program.language === "jq") stage = "embedded-filter";
        }

        if (reason === undefined) {
            let parsed: StatementResponse | undefined;
            if (profile?.kind !== "awk" && profile?.kind !== "jq")
                parsed = await parser.parse(current, program.language, true, signal);

            if (aborted(signal)) return input.code;

            if (parsed !== undefined && "error" in parsed) reason = "parser-unavailable";
            else if (parsed?.malformed === true) reason = "malformed";
            else if (parsed !== undefined) {
                const result = await formatCodeUnit(
                    {
                        key: "embedded",
                        source: current,
                        language: program.language,
                        complete: true,
                        mode: "block",
                        formatter,
                        targetWidth: layout.width,
                        diagnostics: {
                            ...options.diagnostics,
                            stage,
                            sourceCode: current,
                            segmentCode: program.code,
                        },
                    },
                    program.language,
                    {
                        start: 0,
                        end: current.length,
                        format: true,
                        indent: "",
                        kind: "block",
                        literals: literalsIn(parsed),
                    },
                    signal,
                    "",
                );
                if (result.applied === true) formatted = result.text;
            } else {
                formatted = await formatter(
                    {
                        label: program.language,
                        language: program.language,
                        code: current,
                        targetWidth: layout.width,
                        firstLineOffset: layout.firstLineOffset,
                    },
                    {
                        ...options,
                        signal,
                        diagnostics: { ...options.diagnostics, stage, segmentCode: program.code },
                    },
                );
            }
        }

        if (aborted(signal)) return input.code;

        if (formatted?.includes("\0") === true) {
            formatted = undefined;
            reason = "unsafe-nul";
        }

        if (formatted !== undefined && (profile?.kind === "awk" || profile?.kind === "jq")) {
            formatted = formatted
                .split("\n")
                .map((line, index) => {
                    if (index === 0 || line.length === 0) return line;
                    return base + line;
                })
                .join("\n");
        }

        let result = formatted ?? current;
        if (program.origin !== "inline" && result !== program.code) {
            let encoded = result;
            if (!program.quoted) encoded = result.replace(/[\\$`]/gu, "\\$&");

            if (
                encoded.split(/\r?\n/u).some((line) => {
                    let candidate = line;
                    if (program.stripTabs === true) candidate = candidate.replace(/^\t+/u, "");

                    return candidate === program.delimiter;
                })
            ) {
                result = program.code;
                reason = "unsafe-heredoc";
            } else if (program.code.endsWith("\r\n")) result = result.replace(/\n*$/u, "") + "\r\n";
            else if (program.code.endsWith("\n")) result = result.replace(/\n*$/u, "") + "\n";
        }

        const changed = result !== program.code;

        record(() => ({
            language: program.language,
            origin: program.origin,
            start: program.start,
            end: program.end,
            code: program.code,
            formattable: reason === undefined,
            ...(formatted !== undefined && { formatted: changed }),
            ...(changed && { displayCode: result }),
            ...(reason !== undefined && { skipReason: reason }),
        }));

        if (!changed) continue;

        let text = result;

        if (program.origin === "inline") text = quotedWord(result);
        else if (!program.quoted) text = result.replace(/[\\$`]/gu, "\\$&");

        const list = changes.get(program.parent) ?? [];
        list.push({ start: program.localStart, end: program.localEnd, text });
        changes.set(program.parent, list);
    }

    return replace(input.code, changes.get(undefined) ?? []);
}
