import type { ContextEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    createChainAutocompleteProvider,
    type ChainCompletionSource,
} from "./chain-autocomplete.ts";
import { parseMentions } from "./chain-syntax.ts";
import { applyMentionEditor, createMentionContinuation } from "./editor.ts";
import {
    createMentionExpansion,
    createMentionSelections,
    type ExpansionSource,
    type MentionSnapshot,
} from "./mention-resolution.ts";
import type { MentionRegistration } from "./register-mention.ts";
import { createSourceRuntime, type SourceRuntime } from "./source-runtime.ts";

const MENTION_HUB_PROTOCOL_VERSION = 2;
const MENTION_HUB_PROTOCOL = Symbol.for("zigai.pi-mention-anything.hub-protocol-version");
const MENTION_HUB = Symbol.for("zigai.pi-mention-anything.hub");

export type MentionHub = {
    readonly [MENTION_HUB_PROTOCOL]: typeof MENTION_HUB_PROTOCOL_VERSION;
    add(registration: MentionRegistration): symbol;
    remove(handle: symbol): Promise<void>;
    input(text: string): void;

    context(
        messages: ContextEvent["messages"],
        signal?: AbortSignal,
    ): Promise<ContextEvent["messages"]>;
};

type UnknownDataDescriptor = Omit<PropertyDescriptor, "value"> & { readonly value: unknown };

function isUnknownDataDescriptor(
    descriptor: PropertyDescriptor | undefined,
): descriptor is UnknownDataDescriptor {
    return descriptor !== undefined && Object.hasOwn(descriptor, "value");
}

// oxlint-disable-next-line antislop/no-object-parameters -- Protocol data may be attached to any Pi UI or hub object.
function getOwnDataDescriptor(target: object, key: PropertyKey): UnknownDataDescriptor | undefined {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!isUnknownDataDescriptor(descriptor)) return undefined;
    return descriptor;
}

function isNonNullObject(value: unknown): value is object {
    return typeof value === "object" && value !== null;
}

function isNumber(value: unknown): value is number {
    return typeof value === "number";
}

// oxlint-disable-next-line antislop/no-object-parameters -- Hub records are intentionally structural protocol objects.
function hasOwnFunctionProperty(target: object, key: PropertyKey): boolean {
    return typeof getOwnDataDescriptor(target, key)?.value === "function";
}

/** Reads protocol data shared by independently loaded copies in the same Pi UI session. */
function readHub(ui: ExtensionContext["ui"]): MentionHub | undefined {
    const descriptor = getOwnDataDescriptor(ui, MENTION_HUB);
    if (descriptor === undefined) return undefined;
    if (!isNonNullObject(descriptor.value)) throw new TypeError("Incompatible mention hub");

    const hub = descriptor.value;
    const version = getOwnDataDescriptor(hub, MENTION_HUB_PROTOCOL)?.value;
    if (version !== MENTION_HUB_PROTOCOL_VERSION) {
        let versionLabel = Object.prototype.toString.call(version).slice(8, -1).toLowerCase();
        if (isNumber(version)) versionLabel = version.toString();
        throw new TypeError(`Unsupported mention hub protocol version ${versionLabel}`);
    }

    if (
        !hasOwnFunctionProperty(hub, "add") ||
        !hasOwnFunctionProperty(hub, "remove") ||
        !hasOwnFunctionProperty(hub, "input") ||
        !hasOwnFunctionProperty(hub, "context")
    ) {
        throw new TypeError("Incompatible mention hub");
    }

    // SAFETY: Version and structural checks validate the runtime protocol shared across
    // independently loaded module copies. The UI object fixes the session scope.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: The versioned structural protocol is validated above.
    return hub as MentionHub;
}

function createHub(ctx: ExtensionContext): MentionHub {
    const ui = ctx.ui;
    const runtimes = new Map<string, SourceRuntime>();
    const handles = new Map<symbol, SourceRuntime>();
    const sources: (ChainCompletionSource & ExpansionSource)[] = [];
    const selections = createMentionSelections();
    const expansion = createMentionExpansion();
    const continuation = createMentionContinuation();
    let pendingSnapshots: readonly MentionSnapshot[] = [];
    let pendingText = "";
    let editor: ReturnType<typeof applyMentionEditor> | undefined;
    let autocompleteInstalled = false;
    let autocomplete: ReturnType<typeof createChainAutocompleteProvider> | undefined;
    let activeWarmups = 0;
    const pendingWarmups: SourceRuntime[] = [];
    const warmNext = (): void => {
        while (activeWarmups < 4 && pendingWarmups.length > 0) {
            const runtime = pendingWarmups.shift();
            if (runtime === undefined || runtimes.get(runtime.id) !== runtime) continue;
            activeWarmups += 1;

            // The hub bounds startup work; each controller owns cancellation and safe diagnostics.
            void runtime.controller
                .warm()
                .catch(() => {})
                .finally(() => {
                    activeWarmups -= 1;
                    warmNext();
                });
        }
    };

    let unresolved = new Set<string>();
    const processedContexts = new WeakSet<
        Parameters<ReturnType<typeof createMentionExpansion>["messages"]>[0]
    >();

    const hub: MentionHub = {
        [MENTION_HUB_PROTOCOL]: MENTION_HUB_PROTOCOL_VERSION,
        add(registration: MentionRegistration): symbol {
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(registration.id))
                throw new Error("Mention registration ID must be lowercase kebab-case.");

            const configuration = registration.configuration(ctx);

            if (
                runtimes.has(registration.id) ||
                sources.some((source) => source.trigger === configuration.trigger)
            ) {
                throw new Error(
                    "Mention sources require unique IDs and triggers within a session.",
                );
            }

            if (!configuration.trigger || /[\s/]/.test(configuration.trigger))
                throw new Error("Invalid mention trigger.");

            if (
                configuration.separator !== undefined &&
                (configuration.separator.length !== 1 || /[\s"\\\\]/.test(configuration.separator))
            )
                throw new Error(
                    "Mention separator must be one non-whitespace character other than quote or backslash.",
                );

            const runtime = createSourceRuntime(ctx, registration, configuration);
            const handle = Symbol(registration.id);
            handles.set(handle, runtime);

            const source = runtime.source;
            runtimes.set(registration.id, runtime);
            sources.push(source);

            if (ctx.hasUI && !autocompleteInstalled) {
                autocompleteInstalled = true;
                editor = applyMentionEditor(ctx, {
                    key: Symbol.for("zigai.pi-mention-anything.engine.editor"),
                    continuation,
                    onTextChange: (text) => {
                        selections.reconcile(text);
                        autocomplete?.reconcile(text);
                    },
                    onSubmitText: (text) => hub.input(text),
                    isMentionContext: (line) =>
                        parseMentions(line, sources).some((span) => span.end === line.length),
                    colorLine: (line) => {
                        let colored = "";
                        let offset = 0;
                        for (const span of parseMentions(line, sources)) {
                            colored += line.slice(offset, span.start);

                            let color: "accent" | "warning" = "accent";
                            if (!span.complete || unresolved.has(span.sourceId)) color = "warning";
                            colored += ctx.ui.theme.fg(color, line.slice(span.start, span.end));
                            offset = span.end;
                        }

                        return colored + line.slice(offset);
                    },
                });
                ctx.ui.addAutocompleteProvider((current) => {
                    autocomplete?.dispose();
                    autocomplete = createChainAutocompleteProvider({
                        current,
                        sources,
                        onContinue: () => continuation.request(),
                        resolveSelected: (sourceId, segments, start) =>
                            selections
                                .snapshot(ui.getEditorText())
                                .find(
                                    (snapshot) =>
                                        snapshot.sourceId === sourceId &&
                                        snapshot.start === start &&
                                        segments.every(
                                            (segment, index) =>
                                                snapshot.path[index]?.segment === segment,
                                        ),
                                )
                                ?.path.slice(0, segments.length),
                        onState: (sourceId, status) => {
                            if (status === "ready") unresolved.delete(sourceId);
                            else unresolved.add(sourceId);
                        },
                        onSelection: (selection) => {
                            selections.record(selection, selection.editorText);
                            runtimes
                                .get(selection.sourceId)
                                ?.history.recordSelection(
                                    JSON.stringify(selection.path.map((candidate) => candidate.id)),
                                );
                        },
                    });

                    return autocomplete;
                });
            }

            pendingWarmups.push(runtime);
            warmNext();

            return handle;
        },
        async remove(handle: symbol): Promise<void> {
            const runtime = handles.get(handle);
            if (runtime === undefined) return;

            handles.delete(handle);
            runtimes.delete(runtime.id);

            const index = sources.indexOf(runtime.source);
            if (index !== -1) sources.splice(index, 1);
            await Promise.all([runtime.controller.dispose(), runtime.history.flush()]);

            if (runtimes.size === 0) {
                autocomplete?.dispose();
                autocomplete = undefined;
                editor?.dispose();
                editor = undefined;
                expansion.clear();
                selections.clear();

                if (
                    getOwnDataDescriptor(ui, MENTION_HUB)?.value === hub &&
                    !Reflect.deleteProperty(ui, MENTION_HUB)
                ) {
                    throw new TypeError("Unable to remove the shared mention hub");
                }
            }
        },
        input(text: string): void {
            if (pendingText === text && pendingSnapshots.length > 0) return;

            pendingText = text;
            pendingSnapshots = selections.snapshot(text);
        },
        async context(
            messages: Parameters<ReturnType<typeof createMentionExpansion>["messages"]>[0],
            signal?: AbortSignal,
        ) {
            if (processedContexts.has(messages)) return messages;

            unresolved = new Set();

            const result = await expansion.messages(messages, sources, {
                signal,
                snapshots: pendingSnapshots,
                onUnresolved: (id) => {
                    unresolved.add(id);
                },
            });

            pendingSnapshots = [];
            pendingText = "";
            processedContexts.add(result);

            return result;
        },
    };

    return hub;
}

export function sharedHub(ctx: ExtensionContext): MentionHub {
    const existing = readHub(ctx.ui);
    if (existing !== undefined) return existing;

    const hub = createHub(ctx);
    if (
        !Reflect.defineProperty(ctx.ui, MENTION_HUB, {
            configurable: true,
            value: hub,
        })
    ) {
        throw new TypeError("Unable to store the shared mention hub");
    }

    return hub;
}
