import { createDefinitionDiagnostic } from "../diagnostics.js";
import type { DefinitionDiagnostic } from "../types.js";
import type { SkillArgumentDiagnostic, TypedSkillDiagnostics } from "./types.js";

/** Create a structured typed-skill argument diagnostic. */
export function skillArgumentDiagnostic(input: {
    code: string;
    message: string;
    path?: readonly (string | number)[];
    severity?: DefinitionDiagnostic["severity"];
}): SkillArgumentDiagnostic {
    return createDefinitionDiagnostic(input);
}

/** Convert compiler diagnostics into typed-skill diagnostics without losing structure. */
export function skillArgumentDiagnostics(
    diagnostics: readonly DefinitionDiagnostic[],
): SkillArgumentDiagnostic[] {
    return diagnostics.map((diagnostic) => createDefinitionDiagnostic(diagnostic));
}

/** Build a typed-skill diagnostic report for one skill file. */
export function typedSkillDiagnostics(
    name: string,
    filePath: string,
    diagnostics: readonly DefinitionDiagnostic[],
): TypedSkillDiagnostics {
    return { name, filePath, diagnostics: skillArgumentDiagnostics(diagnostics) };
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
