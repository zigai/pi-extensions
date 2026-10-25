import { visibleWidth } from "@earendil-works/pi-tui";
import { embeddedFilterPrograms } from "../../tools/built-in/bash/filter-programs.ts";
import {
    filterProgramFits,
    filterProgramSkipReason,
    type FilterFormatterProfile,
} from "../../tools/built-in/bash/filter-formatting.ts";
import {
    recordRenderError,
    renderDiagnosticsEnabled,
    type ScriptSegmentDiagnostic,
} from "../../diagnostics/render-events.ts";
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
    const recordSegment = options.diagnostics?.recordSegment;
    const record = (segment: () => ScriptSegmentDiagnostic): void => {
        if (recordSegment !== undefined && renderDiagnosticsEnabled()) recordSegment(segment());
    };

    let display = "";
    let consumed = 0;
    for (const program of embeddedFilterPrograms(source)) {
        const code = source.slice(program.start, program.end);
        const segment = (fields: {
            readonly formattable: boolean;
            readonly formatted?: boolean;
            readonly skipReason?: string;
            readonly displayCode?: string;
        }): ScriptSegmentDiagnostic => ({
            language: program.language,
            origin: "inline",
            start: program.start,
            end: program.end,
            code,
            ...fields,
        });

        if (program.quote !== "single") {
            record(() => segment({ formattable: false, skipReason: "double-quoted" }));
            continue;
        }

        let kind: FilterFormatterProfile["kind"] | undefined = program.language;
        if (formatter.profileFor !== undefined) {
            const profile = formatter.profileFor(program.language);
            if (profile === undefined) {
                record(() => segment({ formattable: false, skipReason: "no-profile" }));
                continue;
            }

            // A generic command profile applies none of the awk/jq safety rules.
            if (profile.kind !== "awk" && profile.kind !== "jq") kind = undefined;
        }

        const rowStart = source.lastIndexOf("\n", program.start - 1) + 1;
        const base = /^[\t ]*/u.exec(source.slice(rowStart))?.[0] ?? "";
        const layout = {
            width: Math.max(1, width - visibleWidth(base)),
            firstLineOffset: visibleWidth(source.slice(rowStart + base.length, program.start)),
        };

        let skipReason: string | undefined;
        if (kind !== undefined) skipReason = filterProgramSkipReason(code, kind, layout);
        else if (filterProgramFits(code, layout)) skipReason = "fits-width";

        if (skipReason !== undefined) {
            const reason = skipReason;

            record(() => segment({ formattable: false, skipReason: reason }));
            continue;
        }

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
                {
                    ...options,
                    diagnostics: {
                        ...(toolCallId !== undefined && { toolCallId }),
                        stage: "embedded-filter",
                        segmentCode: code,
                    },
                },
            );
        } catch (cause: unknown) {
            recordRenderError("embedded-filter.format", cause, toolCallId);
            formatted = undefined;
        }

        if (cancelled()) return source;

        if (formatted === undefined || formatted === code || formatted.includes("'")) {
            let declined = "formatter-declined";
            if (formatted?.includes("'") === true) declined = "single-quote";

            record(() => segment({ formattable: true, formatted: false, skipReason: declined }));
            continue;
        }

        const rows = formatted.split("\n");
        const hung = rows
            .map((row, index) => {
                if (index === 0 || row.length === 0) return row;
                return base + row;
            })
            .join("\n");

        record(() => segment({ formattable: true, formatted: true, displayCode: hung }));

        display += source.slice(consumed, program.start) + hung;
        consumed = program.end;
    }

    if (consumed === 0) return source;
    return display + source.slice(consumed);
}
