import type {
    ExtensionAPI,
    ExtensionContext,
    SessionBeforeCompactEvent,
    SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";

export type CompactionHandler = {
    available(ctx: ExtensionContext): boolean;

    compact(
        event: SessionBeforeCompactEvent,
        ctx: ExtensionContext,
    ): Promise<SessionBeforeCompactResult | undefined>;

    defaultPriority?: number;
};

export type CompactionHandlerHandle = { update(handler: CompactionHandler): void; dispose(): void };
export type CompactionSelector = (ctx: ExtensionContext) => string | undefined;

export type CompactionSelectionHandle = {
    update(select: CompactionSelector): void;
    dispose(): void;
};

type HandlerEntry = { handler: CompactionHandler; lifetime: AbortController };

type Coordinator = {
    register(name: string, handler: CompactionHandler): CompactionHandlerHandle;
    select(owner: string, select: CompactionSelector): CompactionSelectionHandle;
};

type CoordinatorQuery = { version: 1; accept(value: Coordinator): void };

const QUERY_EVENT = "pi:compaction-coordinator";
const SELECTED_EVENT = "pi:compaction-selected";

function isCoordinatorQuery(value: unknown): value is CoordinatorQuery {
    return (
        typeof value === "object" &&
        value !== null &&
        "version" in value &&
        value.version === 1 &&
        "accept" in value &&
        typeof value.accept === "function"
    );
}

function isCoordinator(value: unknown): value is Coordinator {
    return (
        typeof value === "object" &&
        value !== null &&
        "register" in value &&
        typeof value.register === "function" &&
        "select" in value &&
        typeof value.select === "function"
    );
}

function coordinator(pi: ExtensionAPI): Coordinator {
    let shared: Coordinator | undefined;

    pi.events.emit(QUERY_EVENT, {
        version: 1,
        accept: (value: Coordinator) => {
            if (isCoordinator(value)) shared = value;
        },
    });

    if (shared !== undefined) return shared;

    const handlers = new Map<string, HandlerEntry>();
    let selector: { owner: string; select: CompactionSelector } | undefined;
    const subscriptions: Array<() => void> = [];
    const release = (): void => {
        if (handlers.size !== 0 || selector !== undefined) return;

        for (const unsubscribe of subscriptions) unsubscribe();
    };

    const selected = (ctx: ExtensionContext, name: string): void => {
        pi.events.emit(SELECTED_EVENT, {
            version: 1,
            sessionId: ctx.sessionManager.getSessionId(),
            name,
        });
    };

    const fail = (ctx: ExtensionContext, message: string): SessionBeforeCompactResult => {
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        else process.stderr.write(`${message}\n`);

        return { cancel: true };
    };

    const registry: Coordinator = {
        register(name, handler) {
            if (name === "pi" || name.trim().length === 0 || handlers.has(name))
                throw new Error(`Compaction handler ${name} is already registered or reserved.`);

            const entry = { handler, lifetime: new AbortController() };
            handlers.set(name, entry);

            let disposed = false;

            return {
                update(next) {
                    if (!disposed) entry.handler = next;
                },
                dispose() {
                    if (disposed) return;

                    disposed = true;
                    entry.lifetime.abort();
                    handlers.delete(name);
                    release();
                },
            };
        },
        select(owner, select) {
            if (selector !== undefined)
                throw new Error(`Compaction selection is already owned by ${selector.owner}.`);

            const entry = { owner, select };
            selector = entry;

            let disposed = false;

            return {
                update(next) {
                    if (!disposed) entry.select = next;
                },
                dispose() {
                    if (disposed) return;

                    disposed = true;
                    selector = undefined;
                    release();
                },
            };
        },
    };

    subscriptions.push(
        pi.events.on(QUERY_EVENT, (value) => {
            if (isCoordinatorQuery(value)) value.accept(registry);
        }),
    );
    subscriptions.push(
        pi.on("session_before_compact", async (event, ctx) => {
            if (event.signal.aborted) return { cancel: true };

            const model = ctx.model;
            const operationContext: ExtensionContext = { ...ctx, model };
            let signal = event.signal;
            let name = "selection";

            try {
                const choice = selector?.select(operationContext);
                if (choice !== undefined) name = choice;
                else {
                    const available = [...handlers]
                        .filter(([, entry]) => entry.handler.available(operationContext))
                        .sort(
                            (left, right) =>
                                (right[1].handler.defaultPriority ?? 0) -
                                    (left[1].handler.defaultPriority ?? 0) ||
                                left[0].localeCompare(right[0]),
                        );
                    const first = available.at(0);
                    const second = available.at(1);
                    if (
                        first !== undefined &&
                        second !== undefined &&
                        (first[1].handler.defaultPriority ?? 0) ===
                            (second[1].handler.defaultPriority ?? 0)
                    )
                        return fail(
                            ctx,
                            "Compaction default handlers conflict; select a named handler.",
                        );

                    name = first?.[0] ?? "pi";
                }

                selected(ctx, name);

                if (name === "pi") return undefined;

                const entry = handlers.get(name);
                if (entry === undefined || !entry.handler.available(operationContext))
                    return fail(ctx, `Selected compaction handler ${name} is unavailable.`);

                const handler = entry.handler;
                signal = AbortSignal.any([event.signal, entry.lifetime.signal]);

                const result = await handler.compact({ ...event, signal }, operationContext);

                if (signal.aborted) return { cancel: true };
                if (result === undefined) selected(ctx, "pi");
                return result;
            } catch {
                if (signal.aborted) return { cancel: true };
                return fail(ctx, `Selected compaction handler ${name} failed.`);
            }
        }),
    );

    return registry;
}

export function registerCompactionHandler(
    pi: ExtensionAPI,
    name: string,
    handler: CompactionHandler,
): CompactionHandlerHandle {
    return coordinator(pi).register(name, handler);
}

export function registerCompactionSelector(
    pi: ExtensionAPI,
    owner: string,
    select: CompactionSelector,
): CompactionSelectionHandle {
    return coordinator(pi).select(owner, select);
}
