export type ToolLabelMode = "static" | "lifecycle";

export type ToolLifecycleLabels = {
    readonly static: string;
    readonly active: string;
    readonly completed: string;
};

export type ToolLifecycleContext = {
    readonly isPartial: boolean;
    readonly argsComplete?: boolean;
    readonly result?: unknown;
};

/** Returns whether a tool call is still receiving arguments or executing. */
export function isActiveToolCall(context: ToolLifecycleContext): boolean {
    if (context.result !== undefined) return false;
    return context.isPartial || context.argsComplete === false;
}

/** Defers compact one-shot calls until their argument object is complete. */
export function shouldDeferSimpleToolCall(context: ToolLifecycleContext): boolean {
    return isActiveToolCall(context);
}

/** Selects a stable label or the active/completed lifecycle form. */
export function toolStatusLabel(
    mode: ToolLabelMode,
    context: ToolLifecycleContext,
    labels: ToolLifecycleLabels,
): string {
    if (mode === "static") {
        return labels.static;
    }
    return isActiveToolCall(context) ? labels.active : labels.completed;
}
