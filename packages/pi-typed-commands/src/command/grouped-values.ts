import {
    expandGroupedArgumentValues,
    flattenGroupedArgumentDefinitions,
    hasArgumentGroups,
} from "../arguments.js";
import type {
    ArgumentDefinitions,
    ArgumentPath,
    ArgumentValue,
    FlatArgumentDefinitions,
    InferArguments,
    ParsedArgumentDraft,
    TypedCommandRefinement,
    TypedCommandRefinementContext,
} from "../types.js";
import type { TypedCommandHandler } from "../pi/command-types.js";

function expandValidatedGroupedValues<TDefinitions extends ArgumentDefinitions>(
    values: InferArguments<FlatArgumentDefinitions>,
    definitions: TDefinitions,
): InferArguments<TDefinitions>;
function expandValidatedGroupedValues<TDefinitions extends ArgumentDefinitions>(
    values: ParsedArgumentDraft<FlatArgumentDefinitions>,
    definitions: TDefinitions,
): ParsedArgumentDraft<TDefinitions>;
function expandValidatedGroupedValues<TDefinitions extends ArgumentDefinitions>(
    values: InferArguments<FlatArgumentDefinitions> | ParsedArgumentDraft<FlatArgumentDefinitions>,
    definitions: TDefinitions,
): InferArguments<TDefinitions> | ParsedArgumentDraft<TDefinitions> {
    let expanded: Readonly<Record<string, unknown>> = values;
    if (hasArgumentGroups(definitions)) {
        expanded = expandGroupedArgumentValues(values, definitions);
    }
    // SAFETY: overload inputs are parser/refinement values already validated against the compiled
    // flat definitions. Expansion changes only keys according to the same source definition tree;
    // total handler input remains total, while draft input remains optional.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: validated leaves are regrouped through their matching definition tree.
    return expanded as InferArguments<TDefinitions> | ParsedArgumentDraft<TDefinitions>;
}

function expandRefinementValues<TDefinitions extends ArgumentDefinitions>(
    values: ParsedArgumentDraft<FlatArgumentDefinitions>,
    definitions: TDefinitions,
): ParsedArgumentDraft<TDefinitions> {
    const projected: Record<string, ArgumentValue> = {};
    for (const key of Object.keys(flattenGroupedArgumentDefinitions(definitions))) {
        if (Object.hasOwn(values, key)) {
            projected[key] = values[key];
        }
    }

    return expandValidatedGroupedValues(projected, definitions);
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

/** Adapt grouped refinement callbacks to the parser's flat dotted-value representation. */
export function maybeWrapGroupedRefinement<TDefinitions extends ArgumentDefinitions>(
    definitions: TDefinitions,
    refine: TypedCommandRefinement<TDefinitions> | undefined,
): TypedCommandRefinement<FlatArgumentDefinitions> | undefined {
    if (refine === undefined) {
        return undefined;
    }

    return (args, context) =>
        refine(expandRefinementValues(args, definitions), refinementContext(definitions, context));
}

/** Adapt grouped command handlers to the parser's flat dotted-value representation. */
export function maybeWrapGroupedHandler<TDefinitions extends ArgumentDefinitions>(
    definitions: TDefinitions,
    handler: TypedCommandHandler<TDefinitions>,
): TypedCommandHandler<FlatArgumentDefinitions> {
    return (args, ctx) => handler(expandValidatedGroupedValues(args, definitions), ctx);
}
