import { StringEnum } from "@earendil-works/pi-ai";
import {
    createToolSearchExtension,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { prepareSystemPromptOptions } from "@zigai/pi-extension-internals/prompt-preparation";
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
import { GOAL_POLICY_EVENT, parseGoalPolicy } from "./goal-policy.ts";
import { TogglesService } from "./toggles-service.ts";

const CONTEXT_REGISTER_EVENT = "pi-toggles:register-context-key";
const CONTEXT_SET_EVENT = "pi-toggles:set-context";
const CONTEXT_CLEAR_EVENT = "pi-toggles:clear-context";
const CONTEXT_READY_EVENT = "pi-toggles:context-ready";
const modelRoleQuery = Compile(
    Type.Object(
        {
            version: Type.Literal(1),
            role: Type.String(),
            accept: Type.Function([Type.Unknown()], Type.Void()),
        },
        { additionalProperties: false },
    ),
);
const promptQuery = Compile(
    Type.Object(
        {
            version: Type.Literal(1),
            getPrompt: Type.Function([], Type.Unknown()),
            prompt: Type.Optional(Type.String()),
            options: Type.Object({}, { additionalProperties: true }),
            accept: Type.Function([Type.Unknown()], Type.Void()),
        },
        { additionalProperties: false },
    ),
);
const promptValue = Compile(Type.String());

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
    let sessionGeneration = 0;
    const eventUnsubscribers: Array<() => void> = [];

    eventUnsubscribers.push(
        pi.events.on("pi-toggles:model-role", (value) => {
            if (service === undefined || !modelRoleQuery.Check(value)) return;
            const request = modelRoleQuery.Parse(value);
            request.accept(service.getModelRole(request.role));
        }),
        pi.events.on("pi-toggles:prompt-composer", (value) => {
            if (
                service === undefined ||
                !service.activationCoordinationEnabled ||
                !promptQuery.Check(value)
            )
                return;
            const request = promptQuery.Parse(value);
            const current = service;
            request.accept({
                prepare: async () => {
                    await current.preparePrompt(request.prompt, request.options);
                    const basePrompt = promptValue.Parse(request.getPrompt());
                    return current.promptComposer(basePrompt, request.options);
                },
            });
        }),
        pi.events.on(GOAL_POLICY_EVENT, (value) => {
            const policy = parseGoalPolicy(value);
            if (policy !== undefined) service?.acceptGoalPolicy(policy);
        }),
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
            await service.refresh();
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
        const generation = ++sessionGeneration;
        service?.dispose();
        const next = new TogglesService(pi, ctx);
        service = next;
        await next.initialize();
        if (generation !== sessionGeneration) return;
        next.updateStatus();
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

    pi.on("before_agent_start", async (event, ctx) => {
        const current = service;
        const generation = sessionGeneration;
        if (current === undefined || !current.activationCoordinationEnabled) return;
        try {
            await prepareSystemPromptOptions(pi.events, event.systemPromptOptions);
        } catch (cause: unknown) {
            if (service === current && generation === sessionGeneration) ctx.abort();
            throw cause;
        }
        if (service !== current || generation !== sessionGeneration) return;
        let prompt: string | undefined;
        if (event.messageType === "user") prompt = event.prompt;
        await current.preparePrompt(prompt, event.systemPromptOptions);
        if (service !== current || generation !== sessionGeneration) return;
        const systemPrompt = await current
            .promptComposer(
                event.systemPrompt,
                event.systemPromptOptions,
                event.systemPromptOptions.skills ?? [],
            )
            .compose(event.systemPrompt);
        if (service !== current || generation !== sessionGeneration) return;
        return { systemPrompt };
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

    pi.on("model_select", async (event) => {
        if (event.source !== "restore") service?.noteModelSelection();
        await service?.refresh();
    });

    pi.on("thinking_level_select", async () => {
        service?.noteModelSelection();
        await service?.refresh();
    });

    pi.on("session_info_changed", async () => {
        await service?.refresh();
    });

    pi.on("session_tree", async () => {
        await service?.refresh();
    });

    pi.on("session_shutdown", (event) => {
        sessionGeneration += 1;
        service?.dispose();
        service = undefined;
        if (event.reason === "quit" || event.reason === "reload") {
            for (const unsubscribe of eventUnsubscribers) {
                unsubscribe();
            }
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
