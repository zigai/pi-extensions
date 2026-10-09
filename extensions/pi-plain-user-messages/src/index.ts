import {
    installLinkedRenderPatch,
    warnPiInternalPatchUnavailable,
    type LinkedMethodPatchHandle,
} from "@zigai/pi-extension-internals";

import { ensurePlainTextUserMessage, type UserMessageComponentInstance } from "./plain-markdown.ts";
import { userMessageRuntime } from "./user-message-runtime.ts";

const USER_MESSAGE_PLAINTEXT_PATCH_KEY = Symbol.for(
    "zigai.pi-plain-user-messages.user-message-patched",
);
const SCOPE = "pi-plain-user-messages";

type PlainUserMessagesApi = {
    on(event: "session_shutdown", handler: () => void): void;
};

type UserMessagePatchHandle = LinkedMethodPatchHandle<
    UserMessageComponentInstance,
    [width: number],
    string[]
>;

type PatchState = typeof globalThis & {
    [USER_MESSAGE_PLAINTEXT_PATCH_KEY]?: UserMessagePatchHandle | true;
};

function restoreUserMessageRenderingPatch(): void {
    const state: PatchState = globalThis;
    const patch = state[USER_MESSAGE_PLAINTEXT_PATCH_KEY];
    if (patch === undefined || patch === true) return;

    patch.dispose();
    delete state[USER_MESSAGE_PLAINTEXT_PATCH_KEY];
}

async function patchUserMessageRendering(): Promise<void> {
    const state: PatchState = globalThis;
    if (state[USER_MESSAGE_PLAINTEXT_PATCH_KEY] !== undefined) return;

    // The public export resolves to Pi's active bundle in a running TUI.
    const component = userMessageRuntime.parse(await import("@earendil-works/pi-coding-agent"));
    if (component === undefined) {
        warnPiInternalPatchUnavailable(SCOPE, "user message patch");
        return;
    }

    state[USER_MESSAGE_PLAINTEXT_PATCH_KEY] = installLinkedRenderPatch(
        component.prototype,
        (predecessor) =>
            function plainUserMessageRender(
                this: UserMessageComponentInstance,
                width: number,
            ): string[] {
                ensurePlainTextUserMessage(this);
                return predecessor.call(this, width);
            },
    );
}

export default async function plainUserMessagesExtension(pi?: PlainUserMessagesApi): Promise<void> {
    await patchUserMessageRendering();
    pi?.on("session_shutdown", restoreUserMessageRenderingPatch);
}
