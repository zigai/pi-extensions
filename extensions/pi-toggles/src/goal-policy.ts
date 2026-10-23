import { Compile } from "typebox/compile";
import { Type, type Static } from "typebox";

export const GOAL_POLICY_EVENT = "pi-goal:tool-policy";
export const GOAL_POLICY_ACCEPTED_EVENT = "pi-goal:tool-policy-accepted";
export const GOAL_POLICY_RELEASED_EVENT = "pi-goal:tool-policy-released";

const schema = Type.Object(
    {
        version: Type.Literal(1),
        sessionId: Type.String({ minLength: 1 }),
        status: Type.Enum([
            "absent",
            "active",
            "paused",
            "blocked",
            "timeLimited",
            "complete",
        ] as const),
        disabledTools: Type.Array(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
);
const validator = Compile(schema);
export type GoalPolicy = Static<typeof schema>;

export function parseGoalPolicy(value: unknown): GoalPolicy | undefined {
    try {
        return validator.Parse(value);
    } catch {
        return undefined;
    }
}
