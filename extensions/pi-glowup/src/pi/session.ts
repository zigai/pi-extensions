import type {
    ExtensionAPI,
    ExtensionContext,
    ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { warnPiInternalPatchUnavailable } from "@zigai/pi-extension-internals";
import Type, { type Static } from "typebox";
import { Value } from "typebox/value";
import type { ToolExecutionInstance } from "../tools/built-in/context.ts";
import {
    createExplorationFeature,
    hasVisibleAssistantText,
    isExplorationToolName,
} from "../tools/built-in/exploration.ts";

const rowSchema = Type.Object(
    {
        toolCallId: Type.Optional(Type.String()),
        invalidate: Type.Function([], Type.Void()),
        ui: Type.Object(
            { requestRender: Type.Function([], Type.Void()) },
            { additionalProperties: true },
        ),
    },
    { additionalProperties: true },
);

type RenderedRow = Static<typeof rowSchema>;

const rows = new Set<WeakRef<RenderedRow>>();
let observedRows = new WeakSet();

export function observeToolRow(row: ToolExecutionInstance | ToolExecutionComponent): void {
    if (observedRows.has(row)) return;

    if (!Value.Check(rowSchema, row)) {
        warnPiInternalPatchUnavailable("pi-glowup", "tool row invalidation");
        return;
    }

    observedRows.add(row);
    rows.add(new WeakRef(row));
}

export function clearToolRows(): void {
    rows.clear();
    observedRows = new WeakSet();
}

export function requestToolRender(context: Pick<ExtensionContext, "mode">): void {
    if (context.mode !== "tui") return;

    for (const reference of rows) {
        const row = reference.deref();
        if (row === undefined) {
            rows.delete(reference);
            continue;
        }

        row.ui.requestRender();

        return;
    }
}

export function refreshToolRows(
    context: Pick<ExtensionContext, "mode">,
    toolCallId?: string,
): void {
    if (context.mode !== "tui") return;

    for (const reference of rows) {
        const row = reference.deref();
        if (row === undefined) {
            rows.delete(reference);
            continue;
        }

        if (toolCallId !== undefined && row.toolCallId !== toolCallId) continue;

        row.invalidate();
        row.ui.requestRender();
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
    const { explorationGroups } = exploration;

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

        restoreExplorationSession(exploration, ctx.sessionManager);
    });

    pi.on("message_end", (event) => {
        if (event.message.role === "assistant") exploration.setMessage(event.message);

        if (hasVisibleAssistantText(event.message)) {
            explorationGroups.closeActiveGroup();
        }
    });
}
