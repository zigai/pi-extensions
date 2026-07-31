import { Compile } from "typebox/compile";
import { Type, type Static } from "typebox";

export const ACTIVATION_READY_EVENT = "pi-toggles:activation-ready";
export const SET_ACTIVATION_PROPOSAL_EVENT = "pi-toggles:set-activation-proposal";
export const CLEAR_ACTIVATION_PROPOSAL_EVENT = "pi-toggles:clear-activation-proposal";
export const ACTIVATION_PROPOSAL_ACCEPTED_EVENT = "pi-toggles:activation-proposal-accepted";
export const ACTIVATION_COORDINATION_VERSION = 1;

const ownerPattern = "^[a-zA-Z0-9@][a-zA-Z0-9@/._-]*$";
const capabilityNamePattern = "^[a-zA-Z0-9][a-zA-Z0-9._-]*$";

const activationTargetSchema = Type.Object(
    {
        kind: Type.Literal("tool"),
        name: Type.String({ pattern: capabilityNamePattern, maxLength: 200 }),
        source: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
        path: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
    },
    { additionalProperties: false },
);

const activationDecisionSchema = Type.Object(
    {
        target: activationTargetSchema,
        state: Type.Enum(["inherit", "on", "off", "lazy"] as const),
    },
    { additionalProperties: false },
);

const coordinationEnvelopeProperties = {
    version: Type.Literal(ACTIVATION_COORDINATION_VERSION),
    sessionId: Type.String({ minLength: 1, maxLength: 200 }),
};

const activationReadySchema = Type.Object(coordinationEnvelopeProperties, {
    additionalProperties: false,
});

const activationProposalSchema = Type.Object(
    {
        ...coordinationEnvelopeProperties,
        owner: Type.String({ pattern: ownerPattern, maxLength: 200 }),
        decisions: Type.Array(activationDecisionSchema, { maxItems: 100 }),
    },
    { additionalProperties: false },
);

const activationProposalOwnerSchema = Type.Object(
    {
        ...coordinationEnvelopeProperties,
        owner: Type.String({ pattern: ownerPattern, maxLength: 200 }),
    },
    { additionalProperties: false },
);

const activationReadyValidator = Compile(activationReadySchema);
const activationProposalValidator = Compile(activationProposalSchema);
const activationProposalOwnerValidator = Compile(activationProposalOwnerSchema);

export type ActivationReady = Static<typeof activationReadySchema>;
export type ExtensionActivationProposal = Static<typeof activationProposalSchema>;
export type ActivationProposalOwner = Static<typeof activationProposalOwnerSchema>;

export type ActivationCoordinationParseResult<T> =
    | { readonly status: "ok"; readonly value: T }
    | { readonly status: "invalid"; readonly message: string };

function parseWithValidator<T>(
    value: unknown,
    validator: { Parse(input: unknown): T },
): ActivationCoordinationParseResult<T> {
    try {
        return { status: "ok", value: validator.Parse(value) };
    } catch (cause: unknown) {
        return {
            status: "invalid",
            message: cause instanceof Error ? cause.message : String(cause),
        };
    }
}

/** Parse a Pi Toggles activation-ready event payload. */
export function parseActivationReady(
    value: unknown,
): ActivationCoordinationParseResult<ActivationReady> {
    return parseWithValidator(value, activationReadyValidator);
}

/** Parse and refine an extension activation proposal payload. */
export function parseExtensionActivationProposal(
    value: unknown,
): ActivationCoordinationParseResult<ExtensionActivationProposal> {
    return parseWithValidator(value, activationProposalValidator);
}

/** Parse a proposal acceptance or clear payload. */
export function parseActivationProposalOwner(
    value: unknown,
): ActivationCoordinationParseResult<ActivationProposalOwner> {
    return parseWithValidator(value, activationProposalOwnerValidator);
}
