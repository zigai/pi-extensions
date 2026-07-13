import { TaggedError } from "better-result";

export class FileOperationFailed extends TaggedError("FileOperationFailed")<{
    readonly operation: "read" | "write";
    readonly path: string;
    readonly code: string | undefined;
    readonly cause: unknown;
    readonly message: string;
}>() {
    constructor(args: {
        readonly operation: "read" | "write";
        readonly path: string;
        readonly code: string | undefined;
        readonly cause: unknown;
    }) {
        super({
            ...args,
            message: `Could not ${args.operation} ${args.path}`,
        });
    }
}

export class ReadmeMarkersMissing extends TaggedError("ReadmeMarkersMissing")<{
    readonly path: string;
    readonly message: string;
}>() {
    constructor(path: string) {
        super({
            path,
            message: `README generation markers are missing or invalid in ${path}`,
        });
    }
}

export class ProjectManifestInvalid extends TaggedError("ProjectManifestInvalid")<{
    readonly path: string;
    readonly reason: string;
    readonly message: string;
}>() {
    constructor(args: { readonly path: string; readonly reason: string }) {
        super({
            ...args,
            message: `Invalid Pi extension settings manifest in ${args.path}: ${args.reason}`,
        });
    }
}

export class DefinitionModuleInvalid extends TaggedError("DefinitionModuleInvalid")<{
    readonly path: string;
    readonly reason: string;
    readonly message: string;
    readonly cause?: unknown;
}>() {
    constructor(args: {
        readonly path: string;
        readonly reason: string;
        readonly cause?: unknown;
    }) {
        super({
            ...args,
            message: `Invalid settings definition module ${args.path}: ${args.reason}`,
        });
    }
}

export type ArtifactFailure = FileOperationFailed | ReadmeMarkersMissing;

export type ProjectFailure = ArtifactFailure | DefinitionModuleInvalid | ProjectManifestInvalid;
