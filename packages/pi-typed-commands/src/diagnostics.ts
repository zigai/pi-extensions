import type { DefinitionDiagnostic } from "./types.js";

/** Input shape for creating a structured definition diagnostic. */
export type DefinitionDiagnosticInput = {
    code: string;
    message: string;
    path?: readonly (string | number)[];
    severity?: DefinitionDiagnostic["severity"];
};

/** Create a stable structured diagnostic for command or skill definition issues. */
export function createDefinitionDiagnostic(input: DefinitionDiagnosticInput): DefinitionDiagnostic {
    return {
        code: input.code,
        message: input.message,
        path: input.path ?? [],
        severity: input.severity ?? "error",
    };
}

/** Return only human-readable messages from structured diagnostics for UI rendering. */
export function diagnosticMessages(
    diagnostics: readonly Pick<DefinitionDiagnostic, "message">[],
): string[] {
    return diagnostics.map((diagnostic) => diagnostic.message);
}
