import { emptyComponent } from "../../../rendering/core.ts";
import type { ThirdPartyToolRenderer } from "../../types.ts";
import { callState, renderSimpleResult, renderThirdPartyCall } from "../../call-rendering.ts";
import { baseToolName, displayToolName } from "../../tool-values.ts";
import { createAskUserQuestionRenderer } from "./ask-user-question-renderer.ts";

const PI_CORE_TOOL_LABELS = new Map<string, string>([
    ["finalize_plan", "Plan Finalized"],
    ["ask_user_question", "Asked User"],
]);

/** Returns whether a tool name belongs to Pi core UI helpers. */
export function isPiCoreTool(toolName: string): boolean {
    return PI_CORE_TOOL_LABELS.has(baseToolName(toolName));
}

function piCoreCallLabel(toolName: string): string {
    return PI_CORE_TOOL_LABELS.get(baseToolName(toolName)) ?? `Called ${displayToolName(toolName)}`;
}

function createFinalizePlanRenderer(toolName: string): ThirdPartyToolRenderer {
    return {
        renderCall(_args, theme, context) {
            return renderThirdPartyCall(theme, {
                state: callState(context),
                statusText: piCoreCallLabel(toolName),
                body: undefined,
                maxRenderedLines: 1,
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

export function createPiCoreRenderer(toolName: string): ThirdPartyToolRenderer {
    if (baseToolName(toolName) === "ask_user_question") {
        return createAskUserQuestionRenderer(piCoreCallLabel(toolName));
    }
    return createFinalizePlanRenderer(toolName);
}
