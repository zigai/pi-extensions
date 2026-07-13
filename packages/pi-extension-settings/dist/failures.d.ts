declare const FileOperationFailed_base: import("better-result").TaggedErrorClass<"FileOperationFailed", {
    readonly operation: "read" | "write";
    readonly path: string;
    readonly code: string | undefined;
    readonly cause: unknown;
    readonly message: string;
}>;
export declare class FileOperationFailed extends FileOperationFailed_base {
    constructor(args: {
        readonly operation: "read" | "write";
        readonly path: string;
        readonly code: string | undefined;
        readonly cause: unknown;
    });
}
declare const ReadmeMarkersMissing_base: import("better-result").TaggedErrorClass<"ReadmeMarkersMissing", {
    readonly path: string;
    readonly message: string;
}>;
export declare class ReadmeMarkersMissing extends ReadmeMarkersMissing_base {
    constructor(path: string);
}
declare const ProjectManifestInvalid_base: import("better-result").TaggedErrorClass<"ProjectManifestInvalid", {
    readonly path: string;
    readonly reason: string;
    readonly message: string;
}>;
export declare class ProjectManifestInvalid extends ProjectManifestInvalid_base {
    constructor(args: {
        readonly path: string;
        readonly reason: string;
    });
}
declare const DefinitionModuleInvalid_base: import("better-result").TaggedErrorClass<"DefinitionModuleInvalid", {
    readonly path: string;
    readonly reason: string;
    readonly message: string;
    readonly cause?: unknown;
}>;
export declare class DefinitionModuleInvalid extends DefinitionModuleInvalid_base {
    constructor(args: {
        readonly path: string;
        readonly reason: string;
        readonly cause?: unknown;
    });
}
export type ArtifactFailure = FileOperationFailed | ReadmeMarkersMissing;
export type ProjectFailure = ArtifactFailure | DefinitionModuleInvalid | ProjectManifestInvalid;
export {};
//# sourceMappingURL=failures.d.ts.map