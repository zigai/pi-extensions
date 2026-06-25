import {
    expandGroupedArgumentValues,
    flattenGroupedArgumentValues,
    hasArgumentGroups,
} from "../arguments.js";
import { toTypedParseResult } from "../parser.js";
import type {
    ArgumentDefinitions,
    ArgumentValue,
    InferArguments,
    ParsedCommandArguments,
    TypedCommandHandler,
    TypedCommandRefinement,
    TypedParseResult,
} from "../types.js";

/** Expand flat dotted parser values into nested handler values when a definition contains groups. */
export function maybeExpandGroupedValues<TDefinitions extends ArgumentDefinitions>(
    values: Readonly<Record<string, ArgumentValue>>,
    definitions: TDefinitions,
): Record<string, unknown> {
    if (!hasArgumentGroups(definitions)) {
        return { ...values };
    }
    return expandGroupedArgumentValues(values, definitions);
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
): TypedCommandRefinement<TDefinitions> | undefined {
    if (refine === undefined || !hasArgumentGroups(definitions)) {
        return refine;
    }
    return (args, context) => refine(maybeExpandGroupedValues(args, definitions) as never, context);
}

/** Adapt grouped command handlers to the parser's flat dotted-value representation. */
export function maybeWrapGroupedHandler<TDefinitions extends ArgumentDefinitions>(
    definitions: TDefinitions,
    handler: TypedCommandHandler<TDefinitions>,
): TypedCommandHandler<TDefinitions> {
    if (!hasArgumentGroups(definitions)) {
        return handler;
    }
    return (args, ctx) => handler(maybeExpandGroupedValues(args, definitions) as never, ctx);
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
            value: maybeExpandGroupedValues(
                result.value,
                definitions,
            ) as InferArguments<TDefinitions>,
        };
    }
    if (result.status === "error") {
        return {
            ...result,
            partial: maybeExpandGroupedValues(result.partial, definitions) as Partial<
                InferArguments<TDefinitions>
            >,
        };
    }
    return result;
}
