import type { EventBus } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { Type, type Static } from "typebox";

const ACTIVATION_READY_EVENT = "pi-toggles:activation-ready";
const SET_ACTIVATION_PROPOSAL_EVENT = "pi-toggles:set-activation-proposal";
const ACTIVATION_PROPOSAL_ACCEPTED_EVENT = "pi-toggles:activation-proposal-accepted";
const ACTIVATION_COORDINATION_VERSION = 1;

const coordinationEnvelopeProperties = {
    version: Type.Literal(ACTIVATION_COORDINATION_VERSION),
    sessionId: Type.String({ minLength: 1, maxLength: 200 }),
};

const activationReadySchema = Type.Object(coordinationEnvelopeProperties, {
    additionalProperties: false,
});

const activationProposalAcceptedSchema = Type.Object(
    {
        ...coordinationEnvelopeProperties,
        owner: Type.String({ minLength: 1, maxLength: 200 }),
    },
    { additionalProperties: false },
);

const activationReadyValidator = Compile(activationReadySchema);
const activationProposalAcceptedValidator = Compile(activationProposalAcceptedSchema);

type ActivationReady = Static<typeof activationReadySchema>;
type ActivationProposalAccepted = Static<typeof activationProposalAcceptedSchema>;

export type ToolActivationDecision = {
    readonly target: {
        readonly kind: "tool";
        readonly name: string;
    };
    readonly state: "inherit" | "on" | "off" | "lazy";
};

function parseEvent<T>(value: unknown, validator: { Parse(input: unknown): T }): T | undefined {
    try {
        return validator.Parse(value);
    } catch {
        return undefined;
    }
}

/**
 * Optional adapter for Pi Toggles activation ownership.
 *
 * The extension keeps standalone behavior until Pi Toggles synchronously accepts
 * its current-session proposal. Once accepted, subsequent activation updates are
 * proposals only; user policy in Pi Toggles remains authoritative.
 */
export class OptionalTogglesActivation {
    readonly #unsubscribers: Array<() => void>;
    #sessionId: string | undefined;
    #readySessionId: string | undefined;
    #delegatedSessionId: string | undefined;
    #decisions: readonly ToolActivationDecision[] = [];

    constructor(
        private readonly events: EventBus,
        private readonly owner: string,
    ) {
        this.#unsubscribers = [
            events.on(ACTIVATION_READY_EVENT, (value) => {
                const ready = parseEvent<ActivationReady>(value, activationReadyValidator);
                if (ready === undefined) return;
                this.#readySessionId = ready.sessionId;
                this.publishIfReady();
            }),
            events.on(ACTIVATION_PROPOSAL_ACCEPTED_EVENT, (value) => {
                const accepted = parseEvent<ActivationProposalAccepted>(
                    value,
                    activationProposalAcceptedValidator,
                );
                if (
                    accepted === undefined ||
                    accepted.owner !== this.owner ||
                    accepted.sessionId !== this.#sessionId
                ) {
                    return;
                }
                this.#delegatedSessionId = accepted.sessionId;
            }),
        ];
    }

    update(
        sessionId: string,
        decisions: readonly ToolActivationDecision[],
    ): "delegated" | "standalone" {
        if (this.#sessionId !== sessionId) {
            this.#sessionId = sessionId;
            this.#delegatedSessionId = undefined;
        }
        this.#decisions = [...decisions];
        this.publishIfReady();
        return this.#delegatedSessionId === sessionId ? "delegated" : "standalone";
    }

    dispose(): void {
        for (const unsubscribe of this.#unsubscribers) unsubscribe();
        this.#sessionId = undefined;
        this.#readySessionId = undefined;
        this.#delegatedSessionId = undefined;
        this.#decisions = [];
    }

    private publishIfReady(): void {
        if (this.#sessionId === undefined || this.#readySessionId !== this.#sessionId) return;
        this.events.emit(SET_ACTIVATION_PROPOSAL_EVENT, {
            version: ACTIVATION_COORDINATION_VERSION,
            sessionId: this.#sessionId,
            owner: this.owner,
            decisions: this.#decisions,
        });
    }
}
