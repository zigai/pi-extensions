import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { Type, type Static } from "typebox";
import { selectorKey } from "./capability.ts";
import type { SessionPolicy } from "./capability-policy.ts";
import { policyDecisionSchema, type PolicyDecision } from "./settings.ts";

const SESSION_ENTRY_TYPE = "pi-toggles-policy";

const sessionPolicyEntrySchema = Type.Object(
    {
        version: Type.Literal(1),
        activeProfile: Type.Optional(Type.String()),
        overrides: Type.Array(policyDecisionSchema),
    },
    { additionalProperties: false },
);

const sessionPolicyEntryValidator = Compile(sessionPolicyEntrySchema);

type SessionPolicyEntry = Static<typeof sessionPolicyEntrySchema>;

export type RestoredSessionPolicy = {
    readonly policy: SessionPolicy;
    readonly diagnostics: readonly string[];
};

function parseSessionPolicy(value: unknown): SessionPolicyEntry | undefined {
    try {
        return sessionPolicyEntryValidator.Parse(value);
    } catch {
        return undefined;
    }
}

export function restoreSessionPolicy(ctx: ExtensionContext): RestoredSessionPolicy {
    let current: SessionPolicyEntry | undefined;
    const diagnostics: string[] = [];
    for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type !== "custom" || entry.customType !== SESSION_ENTRY_TYPE) {
            continue;
        }
        const parsed = parseSessionPolicy(entry.data);
        if (parsed === undefined) {
            diagnostics.push(`Ignored malformed ${SESSION_ENTRY_TYPE} session entry ${entry.id}.`);
            continue;
        }
        current = parsed;
    }
    return {
        policy:
            current === undefined
                ? { overrides: [] }
                : {
                      overrides: current.overrides,
                      ...(current.activeProfile === undefined
                          ? {}
                          : { activeProfile: current.activeProfile }),
                  },
        diagnostics,
    };
}

export function updateSessionOverrides(
    current: SessionPolicy,
    decisions: readonly PolicyDecision[],
): SessionPolicy {
    const decisionsBySelector = new Map(
        current.overrides.map((decision) => [selectorKey(decision.target), decision]),
    );
    for (const decision of decisions) {
        const key = selectorKey(decision.target);
        if (decision.state === "inherit") {
            decisionsBySelector.delete(key);
        } else {
            decisionsBySelector.set(key, decision);
        }
    }
    return {
        overrides: [...decisionsBySelector.values()],
        ...(current.activeProfile === undefined ? {} : { activeProfile: current.activeProfile }),
    };
}

export function updateSessionActiveProfile(
    current: SessionPolicy,
    activeProfile: string | undefined,
): SessionPolicy {
    return {
        overrides: current.overrides,
        ...(activeProfile === undefined ? {} : { activeProfile }),
    };
}

export function persistSessionPolicy(pi: ExtensionAPI, policy: SessionPolicy): void {
    pi.appendEntry<SessionPolicyEntry>(SESSION_ENTRY_TYPE, {
        version: 1,
        overrides: [...policy.overrides],
        ...(policy.activeProfile === undefined ? {} : { activeProfile: policy.activeProfile }),
    });
}
