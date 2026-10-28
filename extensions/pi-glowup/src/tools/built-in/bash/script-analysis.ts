import {
    diagnosticCodeHash,
    recordRenderEvent,
    renderDiagnosticsEnabled,
    scriptSegmentFields,
    utf8Bytes,
    type ScriptSegmentDiagnostic,
} from "../../../diagnostics/render-events.ts";
import type { DebugLogFields } from "../../../diagnostics/logger.ts";
import { reflowBashCommand } from "./command.ts";
import type { ScriptBlockFormatter } from "./formatter.ts";
import { scriptInvocationFromPrograms } from "./invocation.ts";
import { extractEmbeddedPrograms, type EmbeddedProgram } from "./embedded-programs.ts";

export type ScriptAnalysisInput = {
    readonly toolName: "bash" | "codemode";
    readonly toolCallId: string;
    readonly command: string;
    readonly formatter: ScriptBlockFormatter | undefined;
    readonly programs?: readonly EmbeddedProgram[];

    /**
     * Heredoc and inline awk/jq decisions from embedded formatting; undefined when that pass
     * did not run.
     */
    readonly embeddedDecisions?: readonly ScriptSegmentDiagnostic[];

    /** Why embedded source was not offered to the formatter when no decision was recorded. */
    readonly embeddedSkipReason?: string;

    /** Whether the stored preview differs from the original source. */
    readonly formatted?: boolean;

    /** Final display source used for the shell reflow check. */
    readonly displayCode?: string;
};

function formatterSkipReason(
    formatter: ScriptBlockFormatter | undefined,
    language: string,
): string | undefined {
    if (formatter === undefined) return "no-formatter";
    if (formatter.profileFor !== undefined && formatter.profileFor(language) === undefined)
        return "no-profile";

    return undefined;
}

function standaloneSegment(
    language: string,
    code: string,
    input: ScriptAnalysisInput,
): ScriptSegmentDiagnostic {
    const skipReason = formatterSkipReason(input.formatter, language);

    return {
        language,
        origin: "standalone",
        code,
        formattable: skipReason === undefined,
        ...(input.formatted !== undefined && { formatted: input.formatted }),
        ...(skipReason !== undefined && { skipReason }),
    };
}

function shellSegments(input: ScriptAnalysisInput): ScriptSegmentDiagnostic[] {
    return (input.programs ?? extractEmbeddedPrograms(input.command)).map((program) => {
        const recorded = input.embeddedDecisions?.find(
            (segment) =>
                segment.start === program.start &&
                segment.end === program.end &&
                segment.language === program.language &&
                segment.code === program.code,
        );
        if (recorded !== undefined) return recorded;

        let skipReason = input.embeddedSkipReason ?? "not-detected-for-formatting";
        if (input.formatter === undefined) skipReason = "no-formatter";
        else if (program.incomplete) skipReason = "incomplete-heredoc";
        else if (program.expandable) skipReason = "unquoted-expansion";
        else if (
            input.formatter.profileFor !== undefined &&
            input.formatter.profileFor(program.language) === undefined
        )
            skipReason = "no-profile";

        return {
            language: program.language,
            origin: program.origin,
            start: program.start,
            end: program.end,
            code: program.code,
            formattable: false,
            skipReason,
        };
    });
}

function analysisFields(input: ScriptAnalysisInput): DebugLogFields {
    const { command } = input;
    const base = {
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        commandHash: diagnosticCodeHash(command),
        commandBytes: utf8Bytes(command),
        argsComplete: true,
    };

    if (input.toolName === "codemode") {
        return {
            ...base,
            path: "standalone",
            standalone: { language: "javascript" },
            segments: [scriptSegmentFields(standaloneSegment("javascript", command, input))],
            reflowed: false,
        };
    }

    const standalone = scriptInvocationFromPrograms(
        input.programs ?? extractEmbeddedPrograms(command),
    );
    if (standalone !== undefined) {
        return {
            ...base,
            path: "standalone",
            standalone: { language: standalone.language, launcher: standalone.launcher },
            segments: [
                scriptSegmentFields(standaloneSegment(standalone.language, standalone.code, input)),
            ],
            reflowed: false,
        };
    }

    return {
        ...base,
        path: "shell",
        segments: shellSegments(input).map(scriptSegmentFields),
        reflowed: reflowBashCommand(input.displayCode ?? command) !== undefined,
    };
}

/** Records what Glowup extracted from one completed tool call, once per command. */
export function recordScriptAnalysis(input: ScriptAnalysisInput): void {
    if (!renderDiagnosticsEnabled()) return;

    recordRenderEvent(
        "script_analysis",
        () => analysisFields(input),
        () => `${input.toolCallId}\0${diagnosticCodeHash(input.command)}\0true`,
    );
}
