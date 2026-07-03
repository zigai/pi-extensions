export type CodexConfigDiagnosticReason = "invalid" | "malformed-json" | "unreadable";

export type CodexConfigDiagnostic = {
    readonly _tag: "CodexConfigDiagnostic";
    readonly path: string;
    readonly reason: CodexConfigDiagnosticReason;
    readonly message: string;
};

export type CodexCoreConfigParseResult<TConfig> = {
    readonly config: TConfig;
    readonly diagnostics: readonly CodexConfigDiagnostic[];
};

export function makeConfigDiagnostic(
    path: string,
    reason: CodexConfigDiagnosticReason,
    message: string,
): CodexConfigDiagnostic {
    return { _tag: "CodexConfigDiagnostic", path, reason, message };
}
