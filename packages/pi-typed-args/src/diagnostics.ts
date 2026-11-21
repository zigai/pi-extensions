import type { DefinitionDiagnostic } from "./types.ts";

export type DefinitionDiagnosticInput = {
    code: string;
    message: string;
    path?: readonly (string | number)[];
    severity?: DefinitionDiagnostic["severity"];
};

export function createDefinitionDiagnostic(input: DefinitionDiagnosticInput): DefinitionDiagnostic {
    return {
        code: input.code,
        message: input.message,
        path: input.path ?? [],
        severity: input.severity ?? "error",
    };
}

export function diagnosticMessages(
    diagnostics: readonly Pick<DefinitionDiagnostic, "message">[],
): string[] {
    return diagnostics.map((diagnostic) => diagnostic.message);
}
