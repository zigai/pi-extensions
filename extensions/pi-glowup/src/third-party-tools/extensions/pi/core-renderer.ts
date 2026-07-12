import { emptyComponent } from "../../../rendering/core.ts";
import type { ToolLabelMode, ToolLifecycleLabels } from "../../../rendering/status-labels.ts";
import type { ThirdPartyToolRenderer } from "../../types.ts";
import {
    callState,
    DEFAULT_TOOL_CALL_PREVIEW_LINES,
    renderSimpleResult,
    renderThirdPartyCall,
    thirdPartyStatusLabel,
} from "../../call-rendering.ts";
import { baseToolName, displayToolName } from "../../tool-values.ts";
import { createAskUserQuestionRenderer } from "./ask-user-question-renderer.ts";

const PI_CORE_TOOL_LABELS = new Map<string, ToolLifecycleLabels>([
    [
        "finalize_plan",
        { static: "Finalize Plan", active: "Finalizing Plan", completed: "Finalized Plan" },
    ],
    ["ask_user_question", { static: "Ask User", active: "Asking User", completed: "Asked User" }],
]);

/** Returns whether a tool name belongs to Pi core UI helpers. */
export function isPiCoreTool(toolName: string): boolean {
    return PI_CORE_TOOL_LABELS.has(baseToolName(toolName));
}

function piCoreCallLabels(toolName: string): ToolLifecycleLabels {
    const staticLabel = displayToolName(toolName);
    return (
        PI_CORE_TOOL_LABELS.get(baseToolName(toolName)) ?? {
            static: staticLabel,
            active: `Calling ${staticLabel}`,
            completed: `Called ${staticLabel}`,
        }
    );
}

function createFinalizePlanRenderer(
    toolName: string,
    labelMode: ToolLabelMode,
): ThirdPartyToolRenderer {
    return {
        renderCall(_args, theme, context) {
            return renderThirdPartyCall(theme, {
                state: callState(context),
                statusText: thirdPartyStatusLabel(labelMode, context, piCoreCallLabels(toolName)),
                body: undefined,
                maxRenderedLines: DEFAULT_TOOL_CALL_PREVIEW_LINES,
                expanded: context.expanded,
                expandable: false,
            });
        },
        renderResult(result, options, theme, context) {
            if (context.isError || options.isPartial) {
                return renderSimpleResult(theme, result, options);
            }
            return emptyComponent();
        },
    };
}

export function createPiCoreRenderer(
    toolName: string,
    labelMode: ToolLabelMode = "static",
): ThirdPartyToolRenderer {
    if (baseToolName(toolName) === "ask_user_question") {
        return createAskUserQuestionRenderer(piCoreCallLabels(toolName), labelMode);
    }
    return createFinalizePlanRenderer(toolName, labelMode);
}
