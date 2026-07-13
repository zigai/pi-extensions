import { type Result as ResultType } from "better-result";
import { FileOperationFailed } from "./failures.ts";
type ReadTextResult = ResultType<string | undefined, FileOperationFailed>;
type WriteResult = ResultType<"created" | "unchanged" | "updated", FileOperationFailed>;
export declare function readTextIfPresentSync(path: string): ReadTextResult;
export declare function writeTextIfMissingSync(path: string, content: string, mode?: number): WriteResult;
export declare function writeTextAtomicallySync(path: string, content: string, mode?: number): WriteResult;
export {};
//# sourceMappingURL=file-system-sync.d.ts.map