import {
    expandGroupedArgumentValues,
    flattenGroupedArgumentDefinitions,
    flattenGroupedArgumentValues,
    hasArgumentGroups,
} from "../arguments.js";
import type {
    ArgumentDefinitions,
    ArgumentPath,
    FlatArgumentDefinitions,
    InferArguments,
    ParsedArgumentDraft,
    TypedCommandHandler,
    TypedCommandRefinement,
    TypedCommandRefinementContext,
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
    const expanded = maybeExpandGroupedValues(values, definitions);
    // SAFETY: handler adapters receive the parser's successfully validated flat value state and
    // only reshape keys according to the same definition tree.
    return expanded as InferArguments<TDefinitions>;
}

function refinementValues<TDefinitions extends ArgumentDefinitions>(
    values: Readonly<Record<string, unknown>>,
    definitions: TDefinitions,
): ParsedArgumentDraft<TDefinitions> {
    const expanded = maybeExpandGroupedValues(values, definitions);
    // SAFETY: refinement adapters receive parser-produced leaves and only reshape paths according
    // to the same definition tree; missing draft leaves remain missing.
    return expanded as ParsedArgumentDraft<TDefinitions>;
}

function isGroupedArgumentPath<TDefinitions extends ArgumentDefinitions>(
    definitions: TDefinitions,
    path: string,
): path is ArgumentPath<TDefinitions> {
    return Object.hasOwn(flattenGroupedArgumentDefinitions(definitions), path);
}

function refinementContext<TDefinitions extends ArgumentDefinitions>(
    definitions: TDefinitions,
    context: TypedCommandRefinementContext<FlatArgumentDefinitions>,
): TypedCommandRefinementContext<TDefinitions> {
    const provided = new Set<ArgumentPath<TDefinitions>>();
    for (const path of context.provided) {
        if (isGroupedArgumentPath(definitions, path)) {
            provided.add(path);
        }
    }
    return { provided };
}

/** Flatten nested handler values into dotted parser values when a definition contains groups. */
export function maybeFlattenGroupedValues<TDefinitions extends ArgumentDefinitions>(
    values: Readonly<Record<string, unknown>>,
    definitions: TDefinitions,
): Record<string, unknown> {
    if (!hasArgumentGroups(definitions)) {
        return { ...values };
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
        refine(refinementValues(args, definitions), refinementContext(definitions, context));
}

/** Adapt grouped command handlers to the parser's flat dotted-value representation. */
export function maybeWrapGroupedHandler<TDefinitions extends ArgumentDefinitions>(
    definitions: TDefinitions,
    handler: TypedCommandHandler<TDefinitions>,
): TypedCommandHandler<FlatArgumentDefinitions> {
    return (args, ctx) => handler(handlerValues(args, definitions), ctx);
}
