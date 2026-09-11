import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    createExplorationFeature,
    hasVisibleAssistantText,
    isExplorationToolName,
} from "../tools/built-in/exploration.ts";

export function refreshToolRows(context: Pick<ExtensionContext, "mode" | "ui">): void {
    if (context.mode === "tui") {
        context.ui.setToolsExpanded(context.ui.getToolsExpanded());
    }
}

export function restoreExplorationSession(
    exploration: ReturnType<typeof createExplorationFeature>,
    sessionManager: ExtensionContext["sessionManager"],
): void {
    exploration.setSource(() => sessionManager.getBranch());
    exploration.restoreExplorationGroupStarts(sessionManager.getBranch());
}

export function installExplorationSession(
    pi: Pick<ExtensionAPI, "on">,
    exploration: ReturnType<typeof createExplorationFeature>,
): void {
    const { explorationGroups, restoreExplorationGroupStarts } = exploration;

    // Pi emits these extension events before constructing/updating transcript rows.
    // Keep only the current host message; persisted chronology is read from getBranch().
    pi.on("message_start", (event) => {
        if (event.message.role === "assistant") exploration.setMessage(event.message);
    });

    pi.on("message_update", (event) => {
        if (event.message.role === "assistant") exploration.setMessage(event.message);
    });

    pi.on("tool_execution_start", (event) => {
        if (!isExplorationToolName(event.toolName)) {
            explorationGroups.registerBoundary(event.toolCallId);
        }
    });

    pi.on("session_tree", (_event, ctx) => {
        // Tree navigation can shorten/change the branch without session_start.
        // Source offsets and row markers belong to the old transcript lifetime.
        exploration.clear();

        const sessionManager = ctx.sessionManager;

        exploration.setSource(() => sessionManager.getBranch());
        restoreExplorationGroupStarts(sessionManager.getBranch());
    });

    pi.on("message_end", (event) => {
        if (event.message.role === "assistant") exploration.setMessage(event.message);

        if (hasVisibleAssistantText(event.message)) {
            explorationGroups.closeActiveGroup();
        }
    });
}
