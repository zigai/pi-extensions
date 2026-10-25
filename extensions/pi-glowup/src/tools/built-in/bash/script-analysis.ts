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
import { embeddedInlineScripts, hasHeredocOperator, parseScriptInvocation } from "./invocation.ts";
import { filterProgramsBeforeHeredoc } from "./filter-programs.ts";
import { filterProgramSafetyReason } from "./filter-formatting.ts";
import { bashHeredocHighlightBodies } from "./script-renderer.ts";

const FORMATTER_MAX_INPUT_BYTES = 64 * 1024;

export type ScriptAnalysisInput = {
    readonly toolName: "bash" | "codemode";
    readonly toolCallId: string;
    readonly command: string;
    readonly formatter: ScriptBlockFormatter | undefined;

    /**
     * Heredoc and inline awk/jq decisions from embedded formatting; undefined when that pass
     * did not run.
     */
    readonly heredocs?: readonly ScriptSegmentDiagnostic[];

    /** Why embedded source was not offered to the formatter when no decision was recorded. */
    readonly heredocSkipReason?: string;

    /** Whether the stored preview differs from the original source. */
    readonly formatted?: boolean;

    /** Final display source used for the shell reflow check. */
    readonly displayCode?: string;
};

function formatterSkipReason(
    formatter: ScriptBlockFormatter | undefined,
    language: string,
    code: string,
): string | undefined {
    if (formatter === undefined) return "no-formatter";
    if (formatter.profileFor !== undefined && formatter.profileFor(language) === undefined)
        return "no-profile";

    if (utf8Bytes(code) > FORMATTER_MAX_INPUT_BYTES) return "input-limit";
    return undefined;
}

function standaloneSegment(
    language: string,
    code: string,
    input: ScriptAnalysisInput,
): ScriptSegmentDiagnostic {
    const skipReason = formatterSkipReason(input.formatter, language, code);

    return {
        language,
        origin: "standalone",
        code,
        formattable: skipReason === undefined,
        ...(input.formatted !== undefined && { formatted: input.formatted }),
        ...(skipReason !== undefined && { skipReason }),
    };
}

function isFilterSegment(segment: ScriptSegmentDiagnostic): boolean {
    return segment.origin === "inline" && (segment.language === "awk" || segment.language === "jq");
}

/** awk/jq programs the embedded formatting pass did not examine, with the reason. */
function unexaminedFilterSegments(input: ScriptAnalysisInput): ScriptSegmentDiagnostic[] {
    const { command, formatter } = input;
    const heredoc = hasHeredocOperator(command);

    return filterProgramsBeforeHeredoc(command).map((program) => {
        let skipReason = input.heredocSkipReason ?? "not-detected-for-formatting";
        if (formatter === undefined) skipReason = "no-formatter";
        else if (heredoc) skipReason = "heredoc-present";
        else if (program.quote !== "single") skipReason = "double-quoted";
        else {
            const profile = formatter.profileFor?.(program.language);
            const code = command.slice(program.start, program.end);
            if (profile === undefined) skipReason = "no-profile";
            else if (profile.kind === "awk" || profile.kind === "jq")
                skipReason = filterProgramSafetyReason(code, profile.kind) ?? skipReason;
        }

        return {
            language: program.language,
            origin: "inline",
            start: program.start,
            end: program.end,
            code: command.slice(program.start, program.end),
            formattable: false,
            skipReason,
        };
    });
}

function shellSegments(input: ScriptAnalysisInput): ScriptSegmentDiagnostic[] {
    const { command } = input;
    const highlighted = bashHeredocHighlightBodies(command);
    const recorded = input.heredocs ?? [];
    let filters = recorded.filter(isFilterSegment);
    if (filters.length === 0) filters = unexaminedFilterSegments(input);

    // The preview highlights some heredocs the formatter pass cannot attach to a command.
    let heredocs = recorded
        .filter((segment) => !isFilterSegment(segment))
        .map((segment) => {
            const body = highlighted.find((candidate) => candidate.start === segment.start);
            if (segment.language !== "text" || body === undefined) return segment;

            return { ...segment, language: body.language };
        });
    if (heredocs.length === 0) {
        let skipReason = input.heredocSkipReason ?? "not-detected-for-formatting";
        if (input.formatter === undefined) skipReason = "no-formatter";

        heredocs = highlighted.map((body) => ({
            language: body.language,
            origin: "heredoc",
            start: body.start,
            end: body.end,
            code: body.code,
            formattable: false,
            skipReason,
        }));
    }

    const inline = embeddedInlineScripts(command).map((script): ScriptSegmentDiagnostic => ({
        language: script.language,
        origin: "inline",
        start: script.start,
        end: script.end,
        code: command.slice(script.start, script.end),
        formattable: false,
        skipReason: "inline-not-formatted",
    }));

    return [...heredocs, ...inline, ...filters].sort(
        (left, right) => (left.start ?? 0) - (right.start ?? 0),
    );
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

    const standalone = parseScriptInvocation(command);
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

    let inlineSkipReason: string | undefined;
    if (hasHeredocOperator(command)) inlineSkipReason = "heredoc-present";

    return {
        ...base,
        path: "shell",
        segments: shellSegments(input).map(scriptSegmentFields),
        inlineSkipReason,
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
