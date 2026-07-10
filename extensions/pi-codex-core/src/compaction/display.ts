import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { NATIVE_COMPACTION_MESSAGE_TEXT, NATIVE_COMPACTION_MESSAGE_TYPE } from "./messages.ts";

/** Register the renderer for Codex native-compaction checkpoint messages. */
export function registerNativeCompactionDisplay(pi: ExtensionAPI): void {
    pi.registerMessageRenderer(NATIVE_COMPACTION_MESSAGE_TYPE, (message, _options, theme) => {
        return {
            render(width: number): string[] {
                const text =
                    typeof message.content === "string"
                        ? message.content
                        : NATIVE_COMPACTION_MESSAGE_TEXT;
                return text.split("\n").map((line) => theme.fg("dim", line).slice(0, width));
            },
            invalidate(): void {},
        };
    });
}
