import type { SkillArgumentDiagnostic, TypedSkillDiagnostics } from "./types.js";

function diagnosticPathFromMessage(message: string): readonly (string | number)[] {
    const match = /^([^:\s]+)(?:[.:][^:\s]+)?/.exec(message);
    if (match?.[1] !== undefined) {
        return [match[1]];
    }
    return [];
}

function skillArgumentDiagnostic(message: string): SkillArgumentDiagnostic {
    return {
        code: "skill.argument.invalid",
        message,
        path: diagnosticPathFromMessage(message),
        severity: "error",
    };
}

/** Convert skill argument diagnostic messages into structured diagnostics. */
export function skillArgumentDiagnostics(messages: string[]): SkillArgumentDiagnostic[] {
    return messages.map(skillArgumentDiagnostic);
}

/** Build a typed-skill diagnostic report for one skill file. */
export function typedSkillDiagnostics(
    name: string,
    filePath: string,
    messages: string[],
): TypedSkillDiagnostics {
    return { name, filePath, diagnostics: skillArgumentDiagnostics(messages) };
}

/** Format typed skill schema diagnostics for display in Pi notifications. */
export function formatTypedSkillDiagnostics(diagnostics: TypedSkillDiagnostics): string {
    return [
        `/skill:${diagnostics.name} has invalid typed arguments in:`,
        diagnostics.filePath,
        "",
        ...diagnostics.diagnostics.map((diagnostic) => `• ${diagnostic.message}`),
    ].join("\n");
}
