import type { Candidate, DiscoveryRequest, Provider } from "./source-contract.ts";

/** Adapt a bounded enumerable source. Large remote sources should implement exact resolution directly. */
export function createListProvider(
    loadItems: (request: DiscoveryRequest) => Promise<readonly Candidate[]>,
): Provider {
    return {
        filtering: "local",
        async discover(request) {
            request.signal.throwIfAborted();
            const items = await loadItems(request);
            if (items.length > 10000)
                throw new Error(
                    "Enumerable mention sources are limited to 10000 items per parent.",
                );

            request.signal.throwIfAborted();
            return { items: items.slice(0, request.limit) };
        },
        async resolve(request) {
            request.signal.throwIfAborted();
            const path: Candidate[] = [];
            for (const [index, segment] of request.segments.entries()) {
                const items = await loadItems({
                    sourceId: request.sourceId,
                    cwd: request.cwd,
                    trusted: request.trusted,
                    query: "",
                    path,
                    limit: 10000,
                    signal: request.signal,
                });

                request.signal.throwIfAborted();

                if (items.length > 10000)
                    throw new Error(
                        "Enumerable mention sources are limited to 10000 items per parent.",
                    );

                const matches = items.filter((item) => item.segment === segment);
                if (matches.length === 0) {
                    return { status: "unresolved", reason: "missing" };
                }

                if (matches.length > 1) {
                    return { status: "unresolved", reason: "ambiguous" };
                }

                const candidate = matches.at(0);
                if (candidate === undefined) {
                    return { status: "unresolved", reason: "missing" };
                }

                const finalSegment = index === request.segments.length - 1;
                if (!finalSegment && !candidate.navigable) {
                    return { status: "unresolved", reason: "not-navigable" };
                }

                path.push(candidate);
            }

            if (path.length === 0) return { status: "unresolved", reason: "empty" };

            const target = path.at(-1);
            if (target?.replacement === undefined) return { status: "resolved", path };

            return { status: "resolved", path, replacement: target.replacement };
        },
    };
}
