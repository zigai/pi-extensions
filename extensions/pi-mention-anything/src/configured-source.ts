import { Type } from "typebox";
import { Value } from "typebox/value";
import { createCommandProvider, executeJsonCommand } from "./command-provider.ts";
import { createListProvider } from "./list-provider.ts";
import {
    mentionItemSchema,
    type ConfiguredMention,
    type ConfiguredMentionItem,
} from "./settings-input.ts";
import type { Candidate, DiscoveryRequest, Provider } from "./source-contract.ts";

const itemsSchema = Type.Array(mentionItemSchema, { maxItems: 10000 });

function candidateOf(item: ConfiguredMentionItem): Candidate {
    return {
        id: item.id ?? item.name,
        label: item.name,
        segment: item.segment ?? item.name,
        description: item.description,
        searchText: item.searchText,
        insertionText: item.insertionText,
        selectable: item.selectable ?? item.navigable !== true,
        navigable: item.navigable ?? false,
        replacement: item.replacement,
    };
}

function children(
    items: readonly ConfiguredMentionItem[],
    request: DiscoveryRequest,
): readonly Candidate[] {
    const ids = request.path.map((candidate) => candidate.id);

    return items
        .filter((item) => {
            const parent = item.parentPath ?? [];

            return parent.length === ids.length && parent.every((id, index) => id === ids[index]);
        })
        .map(candidateOf);
}

/** Settings and commands adapt to the same contract; cache policy belongs to the source controller. */
export function createConfiguredProvider(mention: ConfiguredMention, cwd: string): Provider {
    const source = mention.source;
    if (source.type === "static")
        return createListProvider(async (request) => children(source.items, request));

    const options = {
        command: source.command,
        args: source.args,
        cwd,
        timeoutMs: source.timeoutMs,
        maxOutputBytes: source.maxOutputBytes,
    };
    if (source.mode === "protocol")
        return createCommandProvider({ ...options, filtering: source.filtering ?? "provider" });

    return createListProvider(async (request) => {
        const raw = await executeJsonCommand(options, undefined, request.signal);
        if (!Value.Check(itemsSchema, raw))
            throw new Error("Mention array command returned invalid candidates.");

        return children(raw, request);
    });
}
