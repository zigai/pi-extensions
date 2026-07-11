import { Result, TaggedError, type Result as ResultType } from "better-result";

export type CodexOperation =
    | "codexAuth"
    | "webRun"
    | "imagegen"
    | "viewImageDescription"
    | "codexUsage"
    | "codexResetCredit"
    | "codexResetCredits"
    | "nativeCompaction";

export class CodexAuthUnavailable extends TaggedError("CodexAuthUnavailable")<{
    readonly operation: CodexOperation;
    readonly message: string;
    readonly cause?: unknown;
}>() {}

export class CodexUnsupportedModel extends TaggedError("CodexUnsupportedModel")<{
    readonly operation: CodexOperation;
    readonly message: string;
}>() {}

export class CodexNativeCompactionIncompatible extends TaggedError(
    "CodexNativeCompactionIncompatible",
)<{
    readonly operation: "nativeCompaction";
    readonly checkpointModel: string;
    readonly requestModel: string;
    readonly message: string;
}>() {}

export class CodexRequestCancelled extends TaggedError("CodexRequestCancelled")<{
    readonly operation: CodexOperation;
    readonly message: string;
    readonly cause?: unknown;
}>() {}

export class CodexNetworkUnavailable extends TaggedError("CodexNetworkUnavailable")<{
    readonly operation: CodexOperation;
    readonly provider: string;
    readonly message: string;
    readonly cause: unknown;
}>() {}

export class CodexHttpRequestFailed extends TaggedError("CodexHttpRequestFailed")<{
    readonly operation: CodexOperation;
    readonly provider: string;
    readonly status: number;
    readonly message: string;
}>() {}

export class CodexInvalidJson extends TaggedError("CodexInvalidJson")<{
    readonly operation: CodexOperation;
    readonly provider: string;
    readonly message: string;
    readonly cause: unknown;
}>() {}

export class CodexUnexpectedResponse extends TaggedError("CodexUnexpectedResponse")<{
    readonly operation: CodexOperation;
    readonly provider: string;
    readonly message: string;
}>() {}

export type CodexFailure =
    | CodexAuthUnavailable
    | CodexUnsupportedModel
    | CodexNativeCompactionIncompatible
    | CodexRequestCancelled
    | CodexNetworkUnavailable
    | CodexHttpRequestFailed
    | CodexInvalidJson
    | CodexUnexpectedResponse;

export type CodexResult<T> = ResultType<T, CodexFailure>;

export function ok<T>(value: T): CodexResult<T> {
    return Result.ok(value);
}

export function fail<T = never>(error: CodexFailure): CodexResult<T> {
    return Result.err(error);
}

/** Convert a typed expected failure to a safe framework-boundary Error. */
export function codexFailureToError(error: CodexFailure): Error {
    const frameworkError = new Error(error.message);
    frameworkError.name = error._tag;
    return frameworkError;
}

export function safeCauseMessage(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

export function isAbortCause(cause: unknown): boolean {
    return (
        (cause instanceof DOMException && cause.name === "AbortError") ||
        (cause instanceof Error && (cause.name === "AbortError" || cause.name === "ABORT_ERR"))
    );
}
