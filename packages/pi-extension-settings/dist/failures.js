import { TaggedError } from "better-result";
export class FileOperationFailed extends TaggedError("FileOperationFailed")() {
    constructor(args) {
        super({
            ...args,
            message: `Could not ${args.operation} ${args.path}`,
        });
    }
}
export class ReadmeMarkersMissing extends TaggedError("ReadmeMarkersMissing")() {
    constructor(path) {
        super({
            path,
            message: `README generation markers are missing or invalid in ${path}`,
        });
    }
}
export class ProjectManifestInvalid extends TaggedError("ProjectManifestInvalid")() {
    constructor(args) {
        super({
            ...args,
            message: `Invalid Pi extension settings manifest in ${args.path}: ${args.reason}`,
        });
    }
}
export class DefinitionModuleInvalid extends TaggedError("DefinitionModuleInvalid")() {
    constructor(args) {
        super({
            ...args,
            message: `Invalid settings definition module ${args.path}: ${args.reason}`,
        });
    }
}
//# sourceMappingURL=failures.js.map