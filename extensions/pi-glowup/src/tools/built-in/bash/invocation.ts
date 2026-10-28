import { extractEmbeddedPrograms, type EmbeddedProgram } from "./embedded-programs.ts";

export type ScriptInvocation = {
    readonly label: string;
    readonly language: string;
    readonly code: string;
    readonly launcher?: string;
};

export function scriptInvocationFromPrograms(
    programs: readonly EmbeddedProgram[],
    includeIncomplete = false,
): ScriptInvocation | undefined {
    const program = programs.find(
        (candidate) =>
            candidate.standalone !== undefined &&
            !candidate.expandable &&
            (includeIncomplete || !candidate.incomplete),
    );
    if (program?.standalone === undefined) return undefined;

    let code = program.code.replace(/\r\n?/gu, "\n");
    if (program.origin !== "inline") code = code.replace(/\n$/u, "");

    return {
        label: program.standalone.label,
        language: program.language,
        code,
        launcher: program.standalone.launcher,
    };
}

export function parseScriptInvocation(command: string | undefined): ScriptInvocation | undefined {
    if (command === undefined || command.trim().length === 0) return undefined;
    return scriptInvocationFromPrograms(extractEmbeddedPrograms(command), true);
}
