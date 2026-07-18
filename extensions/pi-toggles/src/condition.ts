import type { Condition } from "./settings.ts";

export type FactScalar = string | number | boolean | null;
export type FactArguments = Readonly<Record<string, FactScalar>>;

export type FactResolution =
    | { readonly status: "known"; readonly value: FactScalar }
    | { readonly status: "missing"; readonly reason: string }
    | { readonly status: "unknown"; readonly reason: string };

export type ConditionValue = true | false | "unknown";

export type ConditionEvaluation = {
    readonly value: ConditionValue;
    readonly diagnostics: readonly string[];
};

export type FactResolver = (name: string, args: FactArguments | undefined) => FactResolution;

function combineAll(evaluations: readonly ConditionEvaluation[]): ConditionEvaluation {
    const diagnostics = evaluations.flatMap((evaluation) => evaluation.diagnostics);
    if (evaluations.some((evaluation) => evaluation.value === false)) {
        return { value: false, diagnostics };
    }
    if (evaluations.some((evaluation) => evaluation.value === "unknown")) {
        return { value: "unknown", diagnostics };
    }
    return { value: true, diagnostics };
}

function combineAny(evaluations: readonly ConditionEvaluation[]): ConditionEvaluation {
    const diagnostics = evaluations.flatMap((evaluation) => evaluation.diagnostics);
    if (evaluations.some((evaluation) => evaluation.value === true)) {
        return { value: true, diagnostics };
    }
    if (evaluations.some((evaluation) => evaluation.value === "unknown")) {
        return { value: "unknown", diagnostics };
    }
    return { value: false, diagnostics };
}

function unknownFact(
    name: string,
    resolution: Exclude<FactResolution, { status: "known" }>,
): ConditionEvaluation {
    return {
        value: "unknown",
        diagnostics: [`Condition fact ${name} is ${resolution.status}: ${resolution.reason}`],
    };
}

function compareLeaf(
    condition: Extract<Condition, { fact: string }>,
    resolve: FactResolver,
): ConditionEvaluation {
    const resolution = resolve(condition.fact, condition.args);
    if ("isDefined" in condition) {
        if (resolution.status === "unknown") {
            return unknownFact(condition.fact, resolution);
        }
        return {
            value: condition.isDefined === (resolution.status === "known"),
            diagnostics: [],
        };
    }
    if (resolution.status !== "known") {
        return unknownFact(condition.fact, resolution);
    }

    const value = resolution.value;
    if ("equals" in condition) {
        return { value: Object.is(value, condition.equals), diagnostics: [] };
    }
    if ("notEquals" in condition) {
        return { value: !Object.is(value, condition.notEquals), diagnostics: [] };
    }
    if ("in" in condition) {
        return {
            value: condition.in.some((candidate) => Object.is(candidate, value)),
            diagnostics: [],
        };
    }
    if ("notIn" in condition) {
        return {
            value: !condition.notIn.some((candidate) => Object.is(candidate, value)),
            diagnostics: [],
        };
    }
    if ("contains" in condition) {
        return typeof value === "string"
            ? { value: value.includes(condition.contains), diagnostics: [] }
            : { value: "unknown", diagnostics: [`Condition fact ${condition.fact} is not text.`] };
    }
    if ("startsWith" in condition) {
        return typeof value === "string"
            ? { value: value.startsWith(condition.startsWith), diagnostics: [] }
            : { value: "unknown", diagnostics: [`Condition fact ${condition.fact} is not text.`] };
    }
    if ("endsWith" in condition) {
        return typeof value === "string"
            ? { value: value.endsWith(condition.endsWith), diagnostics: [] }
            : { value: "unknown", diagnostics: [`Condition fact ${condition.fact} is not text.`] };
    }
    if (typeof value !== "number") {
        return {
            value: "unknown",
            diagnostics: [`Condition fact ${condition.fact} is not numeric.`],
        };
    }
    if ("lessThan" in condition) {
        return { value: value < condition.lessThan, diagnostics: [] };
    }
    if ("lessThanOrEqual" in condition) {
        return { value: value <= condition.lessThanOrEqual, diagnostics: [] };
    }
    if ("greaterThan" in condition) {
        return { value: value > condition.greaterThan, diagnostics: [] };
    }
    return { value: value >= condition.greaterThanOrEqual, diagnostics: [] };
}

export function evaluateCondition(
    condition: Condition,
    resolve: FactResolver,
): ConditionEvaluation {
    if ("all" in condition) {
        return combineAll(condition.all.map((child) => evaluateCondition(child, resolve)));
    }
    if ("any" in condition) {
        return combineAny(condition.any.map((child) => evaluateCondition(child, resolve)));
    }
    if ("not" in condition) {
        const evaluation = evaluateCondition(condition.not, resolve);
        return {
            value: evaluation.value === "unknown" ? "unknown" : !evaluation.value,
            diagnostics: evaluation.diagnostics,
        };
    }
    return compareLeaf(condition, resolve);
}

export function getReferencedFacts(condition: Condition): ReadonlySet<string> {
    if ("all" in condition) {
        return new Set(condition.all.flatMap((child) => [...getReferencedFacts(child)]));
    }
    if ("any" in condition) {
        return new Set(condition.any.flatMap((child) => [...getReferencedFacts(child)]));
    }
    if ("not" in condition) {
        return getReferencedFacts(condition.not);
    }
    return new Set([condition.fact]);
}
