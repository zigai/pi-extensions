import { visibleWidth } from "@earendil-works/pi-tui";
import { embeddedFilterPrograms } from "../../tools/built-in/bash/filter-programs.ts";
import { filterProgramFits } from "../../tools/built-in/bash/filter-formatting.ts";
import type {
    ScriptBlockFormatter,
    ScriptBlockFormatterInput,
    ScriptBlockFormatterOptions,
} from "../../tools/built-in/bash/formatter.ts";

const DEFAULT_TARGET_WIDTH = 88;

/** True when a composed command has an inline awk/jq program a configured profile can format. */
export function hasFormattableFilterProgram(
    command: string,
    formatter: ScriptBlockFormatter | undefined,
): boolean {
    if (formatter?.profileFor === undefined) return false;

    return embeddedFilterPrograms(command).some(
        (program) =>
            program.quote === "single" && formatter.profileFor?.(program.language) !== undefined,
    );
}

/**
 * Formats single-quoted awk/jq programs in place inside a Bash command. The quoted text is
 * literal, so rows may be broken freely while the command stays valid shell. Continuation rows
 * hang from the indentation of the row where the program starts.
 */
export async function formatEmbeddedFilterPrograms(
    input: ScriptBlockFormatterInput,
    formatter: ScriptBlockFormatter | undefined,
    options: ScriptBlockFormatterOptions = {},
): Promise<string> {
    const source = input.code;
    const cancelled = (): boolean => options.signal?.aborted === true;
    if (formatter === undefined || cancelled()) return source;

    const width = input.targetWidth ?? options.targetWidth ?? DEFAULT_TARGET_WIDTH;
    const toolCallId = options.diagnostics?.toolCallId;
    const programOptions: ScriptBlockFormatterOptions = {
        ...options,
        diagnostics: {
            ...(toolCallId !== undefined && { toolCallId }),
            stage: "embedded-filter",
        },
    };
    let display = "";
    let consumed = 0;
    for (const program of embeddedFilterPrograms(source)) {
        if (program.quote !== "single") continue;

        if (
            formatter.profileFor !== undefined &&
            formatter.profileFor(program.language) === undefined
        )
            continue;

        const code = source.slice(program.start, program.end);
        const rowStart = source.lastIndexOf("\n", program.start - 1) + 1;
        const base = /^[\t ]*/u.exec(source.slice(rowStart))?.[0] ?? "";
        const layout = {
            width: Math.max(1, width - visibleWidth(base)),
            firstLineOffset: visibleWidth(source.slice(rowStart + base.length, program.start)),
        };
        if (filterProgramFits(code, layout)) continue;

        let formatted: string | undefined;
        try {
            formatted = await formatter(
                {
                    label: program.language,
                    language: program.language,
                    code,
                    targetWidth: layout.width,
                    firstLineOffset: layout.firstLineOffset,
                },
                programOptions,
            );
        } catch {
            formatted = undefined;
        }

        if (cancelled()) return source;
        if (formatted === undefined || formatted === code || formatted.includes("'")) continue;

        const rows = formatted.split("\n");
        const hung = rows.map((row, index) => {
            if (index === 0 || row.length === 0) return row;
            return base + row;
        });
        display += source.slice(consumed, program.start) + hung.join("\n");
        consumed = program.end;
    }

    if (consumed === 0) return source;
    return display + source.slice(consumed);
}
