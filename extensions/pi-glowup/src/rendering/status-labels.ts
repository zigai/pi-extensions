export type ToolLabelMode = "static" | "lifecycle";

export type ToolLifecycleLabels = {
    readonly static: string;
    readonly active: string;
    readonly completed: string;
};

export type ToolLifecycleContext = {
    readonly isPartial: boolean;
    readonly argsComplete?: boolean;
    readonly executionStarted?: boolean;
    readonly result?: unknown;
};

export function isActiveToolCall(context: ToolLifecycleContext): boolean {
    if (context.result !== undefined) return false;

    return context.isPartial || context.argsComplete === false;
}

export function shouldDeferSimpleToolCall(context: ToolLifecycleContext): boolean {
    if (context.result !== undefined || context.executionStarted === true) {
        return false;
    }

    return context.argsComplete === false;
}

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
