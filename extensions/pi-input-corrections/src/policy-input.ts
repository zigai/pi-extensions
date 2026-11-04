// Use the public root: Pi maps the host-owned TypeBox module in its loader.
import { Type, type StaticDecode } from "typebox";

export const ruleSchema = Type.Object(
    {
        name: Type.String({
            minLength: 1,
            maxLength: 80,
            description: "A descriptive name for this rule.",
        }),
        enabled: Type.Optional(Type.Boolean({ default: true, description: "Enable this rule." })),
        kind: Type.Optional(
            Type.Enum(["literal", "word", "regex"], {
                default: "literal",
                description:
                    "Literal text, a Unicode-delimited literal word, or the documented safe regex subset.",
            }),
        ),
        find: Type.String({
            minLength: 1,
            maxLength: 128,
            description: "Text or regex source to find. Empty-matching regexes are rejected.",
        }),
        replacement: Type.String({
            maxLength: 1024,
            description:
                "Literal replacement text; dollar substitutions and callbacks are not evaluated.",
        }),
        flags: Type.Optional(
            Type.String({
                default: "g",
                maxLength: 5,
                description:
                    "Regex flags: unique g, i, m, s, u only. Ignored for literal/word rules, which replace all occurrences.",
            }),
        ),
    },
    { title: "CorrectionRule", additionalProperties: false },
);

export const policySchema = Type.Object(
    {
        $schema: Type.Optional(Type.String()),
        version: Type.Literal(1),
        trailingQuestionMark: Type.Optional(Type.Boolean({ default: true })),
        rules: Type.Array(ruleSchema, { maxItems: 512 }),
    },
    {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://raw.githubusercontent.com/zigai/pi-tweaks/master/extensions/pi-input-corrections/policy.schema.json",
        title: "Input Correction Policy",
        additionalProperties: false,
    },
);

export type CorrectionRule = StaticDecode<typeof ruleSchema>;
export type CorrectionPolicy = StaticDecode<typeof policySchema>;

export type InputCorrectionsSettings = {
    enabled: boolean;
    trailingQuestionMark: boolean;
    rules: CorrectionRule[];
};
