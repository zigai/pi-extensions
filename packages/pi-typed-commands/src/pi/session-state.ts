import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedTypedCommandUxOptions } from "./settings.js";

type TypedCommandSessionState = {
    readonly options: ResolvedTypedCommandUxOptions;
    readonly submittedInvalidCommand: (editorText: string) => void;
};

const typedCommandSessions = new WeakMap<ExtensionContext, TypedCommandSessionState>();

/** Register the active session callback for submitted invalid command editor text. */
export function registerSubmittedInvalidCommandHandler(
    ctx: ExtensionContext,
    options: ResolvedTypedCommandUxOptions,
    handler: (editorText: string) => void,
): () => void {
    const state: TypedCommandSessionState = { options, submittedInvalidCommand: handler };
    typedCommandSessions.set(ctx, state);
    return () => {
        if (typedCommandSessions.get(ctx) === state) {
            typedCommandSessions.delete(ctx);
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
