import { createDefinitionDiagnostic } from "../diagnostics.ts";
import type { DefinitionDiagnostic } from "../types.ts";
import type { SkillArgumentDiagnostic, TypedSkillDiagnostics } from "./types.ts";

export function skillArgumentDiagnostic(input: {
    code: string;
    message: string;
    path?: readonly (string | number)[];
    severity?: DefinitionDiagnostic["severity"];
}): SkillArgumentDiagnostic {
    return createDefinitionDiagnostic(input);
}

export function skillArgumentDiagnostics(
    diagnostics: readonly DefinitionDiagnostic[],
): SkillArgumentDiagnostic[] {
    return diagnostics.map((diagnostic) => createDefinitionDiagnostic(diagnostic));
}

export function typedSkillDiagnostics(
    name: string,
    filePath: string,
    diagnostics: readonly DefinitionDiagnostic[],
): TypedSkillDiagnostics {
    return { name, filePath, diagnostics: skillArgumentDiagnostics(diagnostics) };
}

export function formatTypedSkillDiagnostics(diagnostics: TypedSkillDiagnostics): string {
    return [
        `/skill:${diagnostics.name} has invalid typed arguments in:`,
        diagnostics.filePath,
        "",
        ...diagnostics.diagnostics.map((diagnostic) => `• ${diagnostic.message}`),
    ].join("\n");
}
