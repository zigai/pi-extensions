import { installKeyedLinkedMethodPatch } from "@zigai/pi-extension-internals";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";

type PromptOptions = Parameters<AgentSession["prompt"]>[1];
type PromptResult = ReturnType<AgentSession["prompt"]>;

const SWAP_MARKER = Symbol.for("pi-ui-tweaks.swap-submit-and-follow-up");
const TERMINAL_ENTER_MARKER = Symbol.for("pi-ui-tweaks.terminal-lf-enter-submit");

type SubmitModePatchHandle = {
    dispose(): void;
};

let installedHandle: SubmitModePatchHandle | undefined;

function swappedStreamingBehavior(options: PromptOptions): PromptOptions {
    if (options?.streamingBehavior === "steer") {
        return { ...options, streamingBehavior: "followUp" };
    }

    if (options?.streamingBehavior === "followUp") {
        return { ...options, streamingBehavior: "steer" };
    }

    return options;
}

function isNonEmpty(value: string | undefined): boolean {
    return value !== undefined && value.length > 0;
}

function shouldNormalizeLfEnter(): boolean {
    return (
        isNonEmpty(process.env.SSH_CONNECTION) ||
        isNonEmpty(process.env.SSH_CLIENT) ||
        isNonEmpty(process.env.SSH_TTY) ||
        isNonEmpty(process.env.TMUX)
    );
}

function patchStreamingBehaviorSwap(): SubmitModePatchHandle {
    return installKeyedLinkedMethodPatch(
        AgentSession.prototype,
        "prompt",
        SWAP_MARKER,
        undefined,
        (predecessor) =>
            async function (
                this: AgentSession,
                text: string,
                options?: PromptOptions,
            ): PromptResult {
                return predecessor.call(this, text, swappedStreamingBehavior(options));
            },
    );
}

function patchTerminalLfEnterSubmit(): SubmitModePatchHandle | undefined {
    if (!shouldNormalizeLfEnter()) return undefined;

    return installKeyedLinkedMethodPatch(
        Editor.prototype,
        "handleInput",
        TERMINAL_ENTER_MARKER,
        undefined,
        (predecessor) =>
            function (this: Editor, data: string): void {
                let normalizedData = data;
                if (data === "\n") {
                    normalizedData = "\r";
                }

                predecessor.call(this, normalizedData);
            },
    );
}

export function applySubmitModeKeymap(): SubmitModePatchHandle {
    if (installedHandle !== undefined) return installedHandle;

    const handles = [patchStreamingBehaviorSwap(), patchTerminalLfEnterSubmit()];
    let disposed = false;
    const handle: SubmitModePatchHandle = {
        dispose(): void {
            if (disposed) return;

            disposed = true;

            for (let index = handles.length - 1; index >= 0; index -= 1) {
                handles[index]?.dispose();
            }

            if (installedHandle === handle) installedHandle = undefined;
        },
    };

    installedHandle = handle;
    return handle;
}
