import { StringEnum } from "@earendil-works/pi-ai";
import {
    createToolSearchExtension,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
    ACTIVATION_COORDINATION_VERSION,
    ACTIVATION_PROPOSAL_ACCEPTED_EVENT,
    ACTIVATION_READY_EVENT,
    CLEAR_ACTIVATION_PROPOSAL_EVENT,
    parseActivationProposalOwner,
    parseExtensionActivationProposal,
    SET_ACTIVATION_PROPOSAL_EVENT,
} from "./activation-coordination.ts";
import { parseClearContext, parseRegisterContextKey, parseSetContext } from "./context-facts.ts";
import { handleTogglesCommand } from "./toggles-command.ts";
import { TogglesService } from "./toggles-service.ts";

const CONTEXT_REGISTER_EVENT = "pi-toggles:register-context-key";
const CONTEXT_SET_EVENT = "pi-toggles:set-context";
const CONTEXT_CLEAR_EVENT = "pi-toggles:clear-context";
const CONTEXT_READY_EVENT = "pi-toggles:context-ready";

function notifyDiagnostics(service: TogglesService, ctx: ExtensionContext): void {
    if (service.diagnostics.length === 0) {
        return;
    }
    const message = `Pi Toggles loaded with ${service.diagnostics.length} diagnostic${service.diagnostics.length === 1 ? "" : "s"}. Run /toggles doctor.`;
    if (ctx.hasUI) {
        ctx.ui.notify(message, "warning");
    } else {
        process.stderr.write(`[pi-toggles:warning] ${message}\n`);
    }
}

/** Register the Pi Toggles capability-policy extension. */
export default function extension(pi: ExtensionAPI): void | Promise<void> {
    let service: TogglesService | undefined;
    const eventUnsubscribers: Array<() => void> = [];

    eventUnsubscribers.push(
        pi.events.on(CONTEXT_REGISTER_EVENT, (value) => {
            const parsed = parseRegisterContextKey(value);
            if (parsed.status === "ok") {
                service?.registerContextKey(parsed.value);
            } else {
                service?.addDiagnostic(
                    `Invalid ${CONTEXT_REGISTER_EVENT} payload: ${parsed.message}`,
                );
            }
        }),
        pi.events.on(CONTEXT_SET_EVENT, (value) => {
            const parsed = parseSetContext(value);
            if (parsed.status === "ok") {
                service?.setContext(parsed.value);
            } else {
                service?.addDiagnostic(`Invalid ${CONTEXT_SET_EVENT} payload: ${parsed.message}`);
            }
        }),
        pi.events.on(CONTEXT_CLEAR_EVENT, (value) => {
            const parsed = parseClearContext(value);
            if (parsed.status === "ok") {
                service?.clearContext(parsed.value);
            } else {
                service?.addDiagnostic(`Invalid ${CONTEXT_CLEAR_EVENT} payload: ${parsed.message}`);
            }
        }),
        pi.events.on(SET_ACTIVATION_PROPOSAL_EVENT, (value) => {
            const parsed = parseExtensionActivationProposal(value);
            if (parsed.status === "invalid") {
                service?.addDiagnostic(
                    `Invalid ${SET_ACTIVATION_PROPOSAL_EVENT} payload: ${parsed.message}`,
                );
                return;
            }
            if (service?.acceptExtensionActivationProposal(parsed.value) !== true) {
                return;
            }
            pi.events.emit(ACTIVATION_PROPOSAL_ACCEPTED_EVENT, {
                version: ACTIVATION_COORDINATION_VERSION,
                sessionId: parsed.value.sessionId,
                owner: parsed.value.owner,
            });
        }),
        pi.events.on(CLEAR_ACTIVATION_PROPOSAL_EVENT, (value) => {
            const parsed = parseActivationProposalOwner(value);
            if (parsed.status === "invalid") {
                service?.addDiagnostic(
                    `Invalid ${CLEAR_ACTIVATION_PROPOSAL_EVENT} payload: ${parsed.message}`,
                );
                return;
            }
            service?.clearExtensionActivationProposal(parsed.value.owner, parsed.value.sessionId);
        }),
    );

    pi.registerCommand("toggles", {
        description: "Inspect, explain, and change Pi capability policy",
        handler: async (args, ctx) => {
            if (service === undefined) {
                ctx.ui.notify("Pi Toggles has not initialized a session.", "error");
                return;
            }
            await handleTogglesCommand(args, ctx, service);
        },
    });

    pi.registerTool({
        name: "search_capabilities",
        label: "Search Capabilities",
        description:
            "Search Pi tools allowed by policy in lazy state and activate up to the configured limit for this session.",
        promptSnippet:
            "Search for additional policy-allowed lazy tools when current tools cannot perform the task",
        promptGuidelines: [
            "Use search_capabilities only when the task needs a tool that is not currently available.",
        ],
        parameters: Type.Object(
            {
                query: Type.String({
                    minLength: 1,
                    maxLength: 1_000,
                    description: "Capability or task to search for.",
                }),
                mode: Type.Optional(
                    StringEnum(["tools"] as const, {
                        description:
                            "Capability catalog to search. Only tools are currently supported.",
                    }),
                ),
                limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
            },
            { additionalProperties: false },
        ),
        async execute(_toolCallId, params) {
            if (service === undefined) {
                throw new Error("Pi Toggles has not initialized a session.");
            }
            const limit = Math.min(params.limit ?? service.lazyToolLimit, service.lazyToolLimit);
            const result = await service.activateLazy(params.query, limit);
            const text =
                result.matches.length === 0
                    ? `No policy-allowed lazy tools matched: ${params.query}`
                    : result.added.length === 0
                      ? `Matching tools were already active: ${result.matches.join(", ")}`
                      : `Activated lazy tools: ${result.added.join(", ")}`;
            return {
                content: [{ type: "text", text }],
                details: result,
            };
        },
    });

    pi.on("session_start", async (_event, ctx) => {
        service?.dispose();
        service = new TogglesService(pi, ctx);
        await service.initialize();
        service.updateStatus();
        pi.events.emit(CONTEXT_READY_EVENT, {
            version: 1,
            sessionId: ctx.sessionManager.getSessionId(),
        });
        notifyDiagnostics(service, ctx);
        if (service.activationCoordinationEnabled) {
            pi.events.emit(ACTIVATION_READY_EVENT, {
                version: ACTIVATION_COORDINATION_VERSION,
                sessionId: ctx.sessionManager.getSessionId(),
            });
            await service.settleActivation();
        }
    });

    pi.on("input", async (event, ctx) => {
        await service?.refresh(event.text);
        const decision = service?.canInvokeSkill(event.text);
        if (decision?.allowed === false) {
            if (ctx.hasUI) {
                ctx.ui.notify(decision.reason, "warning");
            } else {
                process.stderr.write(`[pi-toggles:warning] ${decision.reason}\n`);
            }
            return { action: "handled" };
        }
        return { action: "continue" };
    });

    pi.on("before_agent_start", async (event) => {
        if (service === undefined) {
            return;
        }
        await service.settleActivation();
        return {
            systemPrompt: await service.buildSystemPrompt(
                event.systemPrompt,
                event.systemPromptOptions.skills ?? [],
            ),
        };
    });

    pi.on("tool_call", (event) => {
        const decision = service?.canInvokeTool(event.toolName);
        if (decision?.allowed === false) {
            return { block: true, reason: decision.reason };
        }
        return undefined;
    });

    pi.on("turn_end", async () => {
        await service?.refreshAfterTurn();
    });

    pi.on("model_select", async () => {
        await service?.refresh();
    });

    pi.on("thinking_level_select", async () => {
        await service?.refresh();
    });

    pi.on("session_info_changed", async () => {
        await service?.refresh();
    });

    pi.on("session_tree", async () => {
        await service?.refresh();
    });

    pi.on("session_shutdown", () => {
        service?.dispose();
        service = undefined;
        for (const unsubscribe of eventUnsubscribers) {
            unsubscribe();
        }
    });

    if (typeof createToolSearchExtension !== "function") return;

    return createToolSearchExtension()({
        ...pi,
        getAllTools: () => service?.getDiscoverableTools() ?? pi.getAllTools(),
        setActiveTools: (names) => {
            if (service === undefined) {
                pi.setActiveTools(names);
            } else {
                service.activateDiscoveredTools(names);
            }
        },
    });
}
