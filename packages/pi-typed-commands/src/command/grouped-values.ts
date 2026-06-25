import {
    expandGroupedArgumentValues,
    flattenGroupedArgumentValues,
    hasArgumentGroups,
} from "../arguments.js";
import { toTypedParseResult } from "../parser.js";
import type {
    ArgumentDefinitions,
    ArgumentValue,
    FlatArgumentDefinitions,
    InferArguments,
    ParsedArgumentDraft,
    ParsedCommandArguments,
    TypedCommandHandler,
    TypedCommandRefinement,
    TypedCommandRefinementContext,
    TypedParseResult,
} from "../types.js";

/** Expand flat dotted parser values into nested handler values when a definition contains groups. */
export function maybeExpandGroupedValues<TDefinitions extends ArgumentDefinitions>(
    values: Readonly<Record<string, unknown>>,
    definitions: TDefinitions,
): Record<string, unknown> {
    if (!hasArgumentGroups(definitions)) {
        return { ...values };
    }
    return expandGroupedArgumentValues(values, definitions);
}

function handlerValues<TDefinitions extends ArgumentDefinitions>(
    values: Readonly<Record<string, unknown>>,
    definitions: TDefinitions,
): InferArguments<TDefinitions> {
    return maybeExpandGroupedValues(values, definitions) as InferArguments<TDefinitions>;
}

function refinementValues<TDefinitions extends ArgumentDefinitions>(
    values: Readonly<Record<string, unknown>>,
    definitions: TDefinitions,
): ParsedArgumentDraft<TDefinitions> {
    return maybeExpandGroupedValues(values, definitions) as ParsedArgumentDraft<TDefinitions>;
}

function refinementContext<TDefinitions extends ArgumentDefinitions>(
    context: TypedCommandRefinementContext<FlatArgumentDefinitions>,
): TypedCommandRefinementContext<TDefinitions> {
    return context as TypedCommandRefinementContext<TDefinitions>;
}

/** Flatten nested handler values into dotted parser values when a definition contains groups. */
export function maybeFlattenGroupedValues<TDefinitions extends ArgumentDefinitions>(
    values: Readonly<Record<string, unknown>>,
    definitions: TDefinitions,
): Record<string, ArgumentValue> {
    if (!hasArgumentGroups(definitions)) {
        return { ...(values as Record<string, ArgumentValue>) };
    }
    return flattenGroupedArgumentValues(values, definitions);
}

/** Adapt grouped refinement callbacks to the parser's flat dotted-value representation. */
export function maybeWrapGroupedRefinement<TDefinitions extends ArgumentDefinitions>(
    definitions: TDefinitions,
    refine: TypedCommandRefinement<TDefinitions> | undefined,
): TypedCommandRefinement<FlatArgumentDefinitions> | undefined {
    if (refine === undefined) {
        return undefined;
    }
    return (args, context) =>
        refine(refinementValues(args, definitions), refinementContext<TDefinitions>(context));
}

/** Adapt grouped command handlers to the parser's flat dotted-value representation. */
export function maybeWrapGroupedHandler<TDefinitions extends ArgumentDefinitions>(
    definitions: TDefinitions,
    handler: TypedCommandHandler<TDefinitions>,
): TypedCommandHandler<FlatArgumentDefinitions> {
    return (args, ctx) => handler(handlerValues(args, definitions), ctx);
}

/** Convert parsed flat values into the public parse result shape for grouped definitions. */
export function typedParseResultForDefinition<TDefinitions extends ArgumentDefinitions>(
    parsed: ParsedCommandArguments,
    definitions: TDefinitions,
): TypedParseResult<TDefinitions> {
    const result = toTypedParseResult<TDefinitions>(parsed);
    if (!hasArgumentGroups(definitions)) {
        return result;
    }
    if (result.status === "success") {
        return {
            ...result,
            value: handlerValues(result.value, definitions),
        };
    }
    if (result.status === "error") {
        return {
            ...result,
            partial: refinementValues(result.partial, definitions),
        };
    }
    return result;
}
