import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyPromptHistoryEditor } from "./editor.ts";

export default function (pi: ExtensionAPI) {
    pi.on("session_start", (_event, ctx) => {
        applyPromptHistoryEditor(ctx);
    });
}
