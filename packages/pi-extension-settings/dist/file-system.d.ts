import { type Result as ResultType } from "better-result";
import { FileOperationFailed } from "./failures.ts";
type ReadTextResult = ResultType<string | undefined, FileOperationFailed>;
type WriteResult = ResultType<"created" | "unchanged" | "updated", FileOperationFailed>;
export declare function readTextIfPresent(path: string): Promise<ReadTextResult>;
export declare function writeTextIfMissing(path: string, content: string, mode?: number): Promise<WriteResult>;
export declare function writeTextAtomically(path: string, content: string, mode?: number): Promise<WriteResult>;
export {};
//# sourceMappingURL=file-system.d.ts.map