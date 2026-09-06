export type BuiltInToolName =
    | "read"
    | "bash"
    | "edit"
    | "write"
    | "find"
    | "grep"
    | "ls"
    | "delete"
    | "webSearch";

export function nativeBuiltInToolName(toolName: string): BuiltInToolName | undefined {
    switch (toolName) {
        case "read":
        case "bash":
        case "edit":
        case "write":
        case "find":
        case "grep":
        case "ls":
            return toolName;
        default:
            return undefined;
    }
}

/** Returns the Glowup renderer family for Pi/Cursor/Grok-compatible tool names. */
export function compatBuiltInToolName(toolName: string): BuiltInToolName | undefined {
    switch (toolName) {
        case "Read":
            return "read";
        case "Write":
            return "write";
        case "StrReplace":
        case "Edit":
            return "edit";
        case "Delete":
            return "delete";
        case "LS":
            return "ls";
        case "Grep":
            return "grep";
        case "Glob":
            return "find";
        case "Shell":
            return "bash";
        case "WebSearch":
            return "webSearch";
        default:
            return undefined;
    }
}

/** Returns a canonical built-in renderer family for native and compatible tool names. */
export function canonicalBuiltInToolName(toolName: string): BuiltInToolName | undefined {
    const nativeName = nativeBuiltInToolName(toolName);
    if (nativeName !== undefined) {
        return nativeName;
    }
    const compatibleName = compatBuiltInToolName(toolName);
    if (compatibleName !== undefined) {
        return compatibleName;
    }
    return toolName === "delete" || toolName === "webSearch" ? toolName : undefined;
}
