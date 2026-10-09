import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChainCompletionSource } from "./chain-autocomplete.ts";
import {
    createLazySelectionHistory,
    rankWithSelectionHistory,
    type SelectionHistory,
} from "./initial-suggestions.ts";
import type { ExpansionSource } from "./mention-resolution.ts";
import { createSourceController } from "./source-controller.ts";
import type { Candidate } from "./source-contract.ts";
import type { MentionConfiguration, MentionRegistration } from "./register-mention.ts";

export type SourceRuntime = {
    readonly id: string;
    readonly controller: ReturnType<typeof createSourceController>;
    readonly source: ChainCompletionSource & ExpansionSource;
    readonly history: SelectionHistory;
};

/** Compose one provider's discovery, ranking, persistence and expansion behavior. */
export function createSourceRuntime(
    ctx: ExtensionContext,
    registration: MentionRegistration,
    configuration: MentionConfiguration,
): SourceRuntime {
    const provider = registration.provider(ctx);
    const controller = createSourceController(provider, {
        ...configuration,
        sourceId: registration.id,
        cwd: ctx.cwd,
        trusted: ctx.isProjectTrusted(),
        onError: () =>
            ctx.ui.notify(
                `Mention source ${registration.id} could not refresh its candidates.`,
                "warning",
            ),
    });
    const history = createLazySelectionHistory({
        stateFileName: `pi-mention-anything-${registration.id}-selections.json`,
        errorMessage: `Mention source ${registration.id} could not use its selection history.`,
        onError: (message) => ctx.ui.notify(message, "warning"),
    });
    let replacement: ExpansionSource["replacement"];
    const registrationReplacement = registration.replacement;
    if (registrationReplacement !== undefined) {
        replacement = (
            path,
            options,
        ): ReturnType<NonNullable<MentionRegistration["replacement"]>> =>
            registrationReplacement(path, ctx, options);
    }

    const source: ChainCompletionSource & ExpansionSource = {
        id: registration.id,
        trigger: configuration.trigger,
        separator: configuration.separator,
        completionSuffix: configuration.completionSuffix ?? " ",
        filtering: provider.filtering,
        expansionPolicy: configuration.expansionPolicy,
        replacementTemplate: configuration.replacementTemplate,
        async discover(request) {
            const response = await controller.discover(request);
            if (provider.filtering !== "local" || request.query !== "") return response;

            const initial = configuration.initialSuggestions ?? {
                strategy: "frecency",
                pinned: [],
            };
            const identityOf = (candidate: Candidate): string =>
                JSON.stringify([...request.path.map((parent) => parent.id), candidate.id]);

            const pinned = initial.pinned.flatMap((name) =>
                response.items
                    .filter((candidate) => candidate.id === name || candidate.segment === name)
                    .map(identityOf),
            );
            let ordered = response.items;
            let strategy = initial.strategy;
            if (initial.strategy === "alphabetical") {
                ordered = [...response.items].sort((left, right) =>
                    left.label.localeCompare(right.label),
                );
                strategy = "sourceOrder";
            }

            const items = await rankWithSelectionHistory(
                ordered,
                identityOf,
                { strategy, pinned },
                history,
            );
            return { ...response, items };
        },
        resolve: async (segments, signal) => controller.resolve(segments, signal),
        replacement,
    };

    return { id: registration.id, controller, source, history };
}
