import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ArgumentValue } from "../types.js";
import {
    resolvePiTypedCommandsConfigSnapshot,
    resolveTypedCommandUxOptions,
    type ResolvedTypedCommandUxOptions,
} from "./settings.js";

type PendingExpandedFormArguments = {
    readonly invocationName: string;
    readonly editorText: string;
    readonly values: Readonly<Record<string, ArgumentValue>>;
};

type TypedCommandSessionState = {
    readonly options: ResolvedTypedCommandUxOptions;
    readonly submittedInvalidCommand: (editorText: string) => void;
    pendingExpandedFormArguments?: PendingExpandedFormArguments;
};

const typedCommandSessions = new WeakMap<ExtensionContext, TypedCommandSessionState>();
const fallbackSessionOptions = new WeakMap<ExtensionContext, ResolvedTypedCommandUxOptions>();

function isMultiArgumentValue(value: ArgumentValue): value is readonly string[] {
    return Array.isArray(value);
}

function isKeyValueArgumentValue(value: ArgumentValue): value is Readonly<Record<string, string>> {
    return value !== undefined && typeof value === "object" && !Array.isArray(value);
}

/** Register the active session callback for submitted invalid command editor text. */
export function registerSubmittedInvalidCommandHandler(
    ctx: ExtensionContext,
    options: ResolvedTypedCommandUxOptions,
    handler: (editorText: string) => void,
): () => void {
    const state: TypedCommandSessionState = { options, submittedInvalidCommand: handler };
    typedCommandSessions.set(ctx, state);
    fallbackSessionOptions.set(ctx, options);
    return () => {
        if (typedCommandSessions.get(ctx) === state) {
            typedCommandSessions.delete(ctx);
            fallbackSessionOptions.delete(ctx);
        }
    };
}

/** Mark submitted invalid command text in the active UX session, when one owns the context. */
export function markSubmittedInvalidCommand(ctx: ExtensionContext, editorText: string): boolean {
    const state = typedCommandSessions.get(ctx);
    if (state === undefined) {
        return false;
    }
    state.submittedInvalidCommand(editorText);
    return true;
}

/** Return the settings snapshot passed into the active session for this context. */
export function getTypedCommandSessionOptions(
    ctx: ExtensionContext,
): ResolvedTypedCommandUxOptions | undefined {
    return typedCommandSessions.get(ctx)?.options;
}

/** Resolve at most one configuration snapshot for a command context during its active session. */
export function resolveTypedCommandSessionOptions(
    ctx: ExtensionContext,
): ResolvedTypedCommandUxOptions {
    const active = getTypedCommandSessionOptions(ctx);
    if (active !== undefined) {
        return active;
    }
    const cached = fallbackSessionOptions.get(ctx);
    if (cached !== undefined) {
        return cached;
    }
    const snapshot = resolvePiTypedCommandsConfigSnapshot({
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
    });
    const options = resolveTypedCommandUxOptions({}, snapshot);
    fallbackSessionOptions.set(ctx, options);
    return options;
}

function cloneArgumentValues(
    values: Readonly<Record<string, ArgumentValue>>,
): Readonly<Record<string, ArgumentValue>> {
    const cloned: Record<string, ArgumentValue> = {};
    for (const [name, value] of Object.entries(values)) {
        if (isMultiArgumentValue(value)) {
            cloned[name] = [...value];
            continue;
        }
        if (isKeyValueArgumentValue(value)) {
            cloned[name] = { ...value };
            continue;
        }
        cloned[name] = value;
    }
    return cloned;
}

/** Stage validated expanded-form values for the exact command submitted by the UX bridge. */
export function stageExpandedFormArguments(
    ctx: ExtensionContext,
    invocationName: string,
    editorText: string,
    values: Readonly<Record<string, ArgumentValue>>,
): boolean {
    const state = typedCommandSessions.get(ctx);
    if (state === undefined) {
        return false;
    }
    state.pendingExpandedFormArguments = {
        invocationName,
        editorText,
        values: cloneArgumentValues(values),
    };
    return true;
}

/**
 * Consume form values only when the user submits the exact command produced by the expanded form.
 * Any different typed-command submission invalidates the pending values.
 */
export function takeExpandedFormArguments(
    ctx: ExtensionContext,
    invocationName: string,
    editorText: string,
): Readonly<Record<string, ArgumentValue>> | undefined {
    const state = typedCommandSessions.get(ctx);
    const pending = state?.pendingExpandedFormArguments;
    if (state !== undefined) {
        delete state.pendingExpandedFormArguments;
    }
    if (
        pending === undefined ||
        pending.invocationName !== invocationName ||
        pending.editorText !== editorText
    ) {
        return undefined;
    }
    return cloneArgumentValues(pending.values);
}
