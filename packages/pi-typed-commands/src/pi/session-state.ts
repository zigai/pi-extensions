import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type SubmittedInvalidCommandHandler = (editorText: string) => void;

const submittedInvalidCommandHandlers = new WeakMap<
    ExtensionContext,
    SubmittedInvalidCommandHandler
>();

/** Register the active session callback for submitted invalid command editor text. */
export function registerSubmittedInvalidCommandHandler(
    ctx: ExtensionContext,
    handler: SubmittedInvalidCommandHandler,
): () => void {
    submittedInvalidCommandHandlers.set(ctx, handler);
    return () => {
        if (submittedInvalidCommandHandlers.get(ctx) === handler) {
            submittedInvalidCommandHandlers.delete(ctx);
        }
    };
}

/** Mark submitted invalid command text in the active UX session, when one owns the context. */
export function markSubmittedInvalidCommand(ctx: ExtensionContext, editorText: string): boolean {
    const handler = submittedInvalidCommandHandlers.get(ctx);
    if (handler === undefined) {
        return false;
    }
    handler(editorText);
    return true;
}
