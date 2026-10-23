export type EditorFactory<Args extends readonly unknown[], Editor> = (...args: Args) => Editor;

export type EditorEnhancer<Args extends readonly unknown[], Editor> = (
    editor: Editor,
    ...args: Args
) => Editor;

export type EditorEnhancerContext<Args extends readonly unknown[], Editor> = {
    readonly hasUI: boolean;

    readonly ui: {
        getEditorComponent(): EditorFactory<Args, Editor> | undefined;
        setEditorComponent(factory: EditorFactory<Args, Editor> | undefined): void;
    };
};

export type EditorEnhancerHandle<Args extends readonly unknown[], Editor> = {
    update(enhancer: EditorEnhancer<Args, Editor>): void;
    dispose(): void;
};

export type EditorBackendHandle<Args extends readonly unknown[], Editor> = {
    update(factory: EditorFactory<Args, Editor>): void;
    dispose(): void;
};

type RegistryRelease = () => void;

type BackendState<Args extends readonly unknown[], Editor> = {
    readonly factory: EditorFactory<Args, Editor>;
    previous: EditorFactory<Args, Editor> | undefined;
    readonly successors: Set<EditorFactory<Args, Editor>>;
    disposed: boolean;
};

function isRegistryRelease(value: unknown): value is RegistryRelease {
    return typeof value === "function";
}

const EDITOR_ENHANCER_PROTOCOL_VERSION = 1;
const EDITOR_ENHANCER_PROTOCOL = Symbol.for("zigai.pi-tweaks.editor-enhancer-protocol-version");
const EDITOR_ENHANCER_REGISTRY = Symbol.for("zigai.pi-tweaks.editor-enhancer-registry");
const EDITOR_ENHANCER_FACTORY = Symbol.for("zigai.pi-tweaks.editor-enhancer-factory");
const EDITOR_ENHANCER_RELEASE = Symbol.for("zigai.pi-tweaks.editor-enhancer-release");
const EDITOR_BACKEND_STATE = Symbol.for("zigai.pi-tweaks.editor-backend-state");

type EnhancerEntry<Args extends readonly unknown[], Editor> = {
    enhancer: EditorEnhancer<Args, Editor>;
};

type EditorEnhancerRegistry<Args extends readonly unknown[], Editor> = {
    readonly [EDITOR_ENHANCER_PROTOCOL]: typeof EDITOR_ENHANCER_PROTOCOL_VERSION;
    baseFactory: EditorFactory<Args, Editor> | undefined;
    readonly defaultFactory: EditorFactory<Args, Editor>;
    readonly enhancers: Map<PropertyKey, EnhancerEntry<Args, Editor>>;
    readonly factory: EditorFactory<Args, Editor>;
};

type UnknownDataDescriptor = Omit<PropertyDescriptor, "value"> & { readonly value: unknown };

function isUnknownDataDescriptor(
    descriptor: PropertyDescriptor | undefined,
): descriptor is UnknownDataDescriptor {
    return descriptor !== undefined && Object.hasOwn(descriptor, "value");
}

/** Reads untrusted protocol data written by another bundled package copy. */
// oxlint-disable-next-line antislop/no-object-parameters -- Protocol data may be attached to any Pi UI or factory object.
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

function isPropertyKey(value: unknown): value is PropertyKey {
    return typeof value === "string" || typeof value === "number" || typeof value === "symbol";
}

function isGlobalSymbol(value: unknown): value is symbol {
    return typeof value === "symbol" && Symbol.keyFor(value) !== undefined;
}

// oxlint-disable-next-line antislop/no-object-parameters -- Enhancer records are intentionally structural protocol objects.
function hasOwnFunctionProperty(target: object, key: PropertyKey): boolean {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return false;

    const value: unknown = descriptor.value;
    return typeof value === "function";
}

function hasValidEnhancerEntries(entries: ReadonlyMap<unknown, unknown>, legacy: boolean): boolean {
    for (const [key, entry] of entries) {
        if (legacy) {
            if (!isPropertyKey(key)) return false;
        } else if (!isGlobalSymbol(key)) {
            return false;
        }

        if (!isNonNullObject(entry)) return false;
        if (!hasOwnFunctionProperty(entry, "enhancer")) return false;
    }

    return true;
}

function readRegistry<Args extends readonly unknown[], Editor>(
    ui: EditorEnhancerContext<Args, Editor>["ui"],
): EditorEnhancerRegistry<Args, Editor> | undefined {
    const current = ui.getEditorComponent();
    let recordValue = getOwnDataDescriptor(ui, EDITOR_ENHANCER_REGISTRY)?.value;
    let factoryRecordValue: unknown;
    if (current !== undefined) {
        factoryRecordValue = getOwnDataDescriptor(current, EDITOR_ENHANCER_REGISTRY)?.value;
        if (factoryRecordValue !== undefined) recordValue = factoryRecordValue;
    }

    if (recordValue === undefined) return undefined;

    if (!isNonNullObject(recordValue)) {
        throw new TypeError("Incompatible editor enhancer registry");
    }

    const record = recordValue;
    const version = getOwnDataDescriptor(record, EDITOR_ENHANCER_PROTOCOL)?.value;
    if (version !== undefined && version !== EDITOR_ENHANCER_PROTOCOL_VERSION) {
        let versionLabel = `invalid-${Object.prototype.toString.call(version).slice(8, -1).toLowerCase()}`;
        if (isNumber(version)) versionLabel = version.toString();
        throw new TypeError(`Unsupported editor enhancer protocol version ${versionLabel}`);
    }

    const baseFactory = getOwnDataDescriptor(record, "baseFactory")?.value;
    const defaultFactory = getOwnDataDescriptor(record, "defaultFactory")?.value;
    const enhancers = getOwnDataDescriptor(record, "enhancers")?.value;
    const factory = getOwnDataDescriptor(record, "factory")?.value;

    if (
        (baseFactory !== undefined && typeof baseFactory !== "function") ||
        typeof defaultFactory !== "function" ||
        !(enhancers instanceof Map) ||
        !hasValidEnhancerEntries(enhancers, version === undefined) ||
        typeof factory !== "function" ||
        getOwnDataDescriptor(factory, EDITOR_ENHANCER_FACTORY)?.value !== true
    ) {
        throw new TypeError("Incompatible editor enhancer registry");
    }

    if (
        factoryRecordValue !== undefined &&
        (factory !== current || !hasOwnFunctionProperty(factory, EDITOR_ENHANCER_RELEASE))
    ) {
        throw new TypeError("Incompatible editor enhancer factory registry");
    }

    if (
        version === undefined &&
        !Reflect.defineProperty(record, EDITOR_ENHANCER_PROTOCOL, {
            configurable: true,
            value: EDITOR_ENHANCER_PROTOCOL_VERSION,
        })
    ) {
        throw new TypeError("Unable to mark legacy editor enhancer registry as protocol v1");
    }

    // SAFETY: The checks above validate every runtime field shared between independently
    // bundled protocol copies. Generic arguments are fixed by the owning Pi UI instance.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Version, factories, map entries and factory marker are checked; the owning UI fixes generic editor arguments, which TypeScript cannot recover from cross-bundle symbol descriptors.
    return record as EditorEnhancerRegistry<Args, Editor>;
}

function removeStoredRegistry<Args extends readonly unknown[], Editor>(
    ui: EditorEnhancerContext<Args, Editor>["ui"],
    registry: EditorEnhancerRegistry<Args, Editor>,
): void {
    if (
        getOwnDataDescriptor(ui, EDITOR_ENHANCER_REGISTRY)?.value === registry &&
        !Reflect.deleteProperty(ui, EDITOR_ENHANCER_REGISTRY)
    )
        throw new TypeError("Unable to remove the editor enhancer registry");
}

function removeRegistry<Args extends readonly unknown[], Editor>(
    ui: EditorEnhancerContext<Args, Editor>["ui"],
    registry: EditorEnhancerRegistry<Args, Editor>,
): void {
    const release = getOwnDataDescriptor(registry.factory, EDITOR_ENHANCER_RELEASE)?.value;
    if (release !== undefined) {
        if (!isRegistryRelease(release))
            throw new TypeError("Incompatible editor enhancer registry release");

        release();
    }

    removeStoredRegistry(ui, registry);
}

function markSharedFactory<Args extends readonly unknown[], Editor>(
    registry: EditorEnhancerRegistry<Args, Editor>,
    ui: EditorEnhancerContext<Args, Editor>["ui"],
): void {
    if (
        !Reflect.defineProperty(registry.factory, EDITOR_ENHANCER_REGISTRY, { value: registry }) ||
        !Reflect.defineProperty(registry.factory, EDITOR_ENHANCER_RELEASE, {
            value: () => {
                removeStoredRegistry(ui, registry);
            },
        }) ||
        !Reflect.defineProperty(registry.factory, EDITOR_ENHANCER_FACTORY, { value: true })
    )
        throw new TypeError("Unable to mark the shared editor enhancer factory");
}

function isCurrentSharedFactory<Args extends readonly unknown[], Editor>(
    factory: EditorFactory<Args, Editor> | undefined,
    registry: EditorEnhancerRegistry<Args, Editor>,
): boolean {
    return (
        factory !== undefined &&
        factory === registry.factory &&
        getOwnDataDescriptor(factory, EDITOR_ENHANCER_FACTORY)?.value === true
    );
}

function activateRegistry<Args extends readonly unknown[], Editor>(
    ui: EditorEnhancerContext<Args, Editor>["ui"],
    registry: EditorEnhancerRegistry<Args, Editor>,
): void {
    const current = ui.getEditorComponent();
    if (!isCurrentSharedFactory(current, registry)) {
        registry.baseFactory = current;
    }

    ui.setEditorComponent(registry.factory);
}

function isBackendState<Args extends readonly unknown[], Editor>(
    value: unknown,
): value is BackendState<Args, Editor> {
    if (!isNonNullObject(value)) return false;

    const factory = getOwnDataDescriptor(value, "factory")?.value;
    const previous = getOwnDataDescriptor(value, "previous");
    const successors = getOwnDataDescriptor(value, "successors")?.value;
    const disposed = getOwnDataDescriptor(value, "disposed");

    if (
        typeof factory !== "function" ||
        previous?.writable !== true ||
        (previous.value !== undefined && typeof previous.value !== "function") ||
        !(successors instanceof Set) ||
        disposed?.writable !== true ||
        typeof disposed.value !== "boolean"
    )
        return false;

    for (const successor of successors) {
        if (typeof successor !== "function") return false;
    }

    return true;
}

function readBackendState<Args extends readonly unknown[], Editor>(
    factory: EditorFactory<Args, Editor> | undefined,
): BackendState<Args, Editor> | undefined {
    if (factory === undefined) return undefined;

    const state = getOwnDataDescriptor(factory, EDITOR_BACKEND_STATE)?.value;
    if (state === undefined) return undefined;
    if (!isBackendState<Args, Editor>(state) || state.factory !== factory)
        throw new TypeError("Incompatible editor backend state");

    return state;
}

function resolveEditorBackend<Args extends readonly unknown[], Editor>(
    factory: EditorFactory<Args, Editor> | undefined,
): EditorFactory<Args, Editor> | undefined {
    let current = factory;
    const visited = new Set<EditorFactory<Args, Editor>>();
    while (current !== undefined) {
        if (visited.has(current)) throw new TypeError("Cyclic editor backend chain");

        visited.add(current);

        const state = readBackendState(current);
        if (state === undefined || !state.disposed) return current;

        current = state.previous;
    }

    return undefined;
}

export function registerEditorBackend<Args extends readonly unknown[], Editor>(
    ctx: EditorEnhancerContext<Args, Editor>,
    factory: EditorFactory<Args, Editor>,
): EditorBackendHandle<Args, Editor> {
    const registry = readRegistry(ctx.ui);
    let previous = ctx.ui.getEditorComponent();
    if (registry !== undefined && isCurrentSharedFactory(previous, registry))
        previous = registry.baseFactory;

    let current = factory;
    const backend: EditorFactory<Args, Editor> = (...args) => current(...args);
    const state: BackendState<Args, Editor> = {
        factory: backend,
        previous: resolveEditorBackend(previous),
        successors: new Set(),
        disposed: false,
    };
    Object.defineProperty(backend, EDITOR_BACKEND_STATE, { value: state });

    const install = (next: EditorFactory<Args, Editor> | undefined): void => {
        const shared = readRegistry(ctx.ui);
        if (shared === undefined || !isCurrentSharedFactory(ctx.ui.getEditorComponent(), shared)) {
            ctx.ui.setEditorComponent(next);
            return;
        }

        const before = shared.baseFactory;
        shared.baseFactory = next;

        try {
            activateRegistry(ctx.ui, shared);
        } catch (cause) {
            shared.baseFactory = before;
            throw cause;
        }
    };

    const ownsBase = (): boolean => {
        const shared = readRegistry(ctx.ui);
        if (shared !== undefined && isCurrentSharedFactory(ctx.ui.getEditorComponent(), shared)) {
            return shared.baseFactory === backend;
        }

        return ctx.ui.getEditorComponent() === backend;
    };

    if (ctx.hasUI) {
        install(backend);
        readBackendState(state.previous)?.successors.add(backend);
    }

    return {
        update(next): void {
            if (state.disposed || !ctx.hasUI || !ownsBase()) return;

            const before = current;
            current = next;

            try {
                install(backend);
            } catch (cause) {
                current = before;
                throw cause;
            }
        },
        dispose(): void {
            if (state.disposed) return;

            const predecessor = resolveEditorBackend(state.previous);
            const predecessorState = readBackendState(predecessor);
            const successors: BackendState<Args, Editor>[] = [];
            for (const successor of state.successors) {
                const successorState = readBackendState(successor);
                if (
                    successorState === undefined ||
                    successorState.previous !== backend ||
                    successorState.disposed
                )
                    throw new TypeError("Incompatible editor backend successor");

                successors.push(successorState);
            }

            if (ctx.hasUI && ownsBase()) install(predecessor);
            predecessorState?.successors.delete(backend);

            for (const successor of successors) {
                successor.previous = predecessor;
                predecessorState?.successors.add(successor.factory);
            }

            state.successors.clear();
            state.previous = undefined;
            state.disposed = true;
        },
    };
}

/**
 * Registers one keyed editor transformation in the shared editor factory stack.
 *
 * The key must come from `Symbol.for(...)` so independently bundled copies and extension
 * reloads replace the same registration. The first registration owns the fallback factory;
 * later registrations compose enhancers without changing that fallback.
 */
export function registerEditorEnhancer<Args extends readonly unknown[], Editor>(
    ctx: EditorEnhancerContext<Args, Editor>,
    key: symbol,
    createDefaultEditor: EditorFactory<Args, Editor>,
    enhancer: EditorEnhancer<Args, Editor>,
): EditorEnhancerHandle<Args, Editor> {
    if (Symbol.keyFor(key) === undefined) {
        throw new TypeError("Editor enhancer keys must be created with Symbol.for(...)");
    }

    if (!ctx.hasUI) {
        return {
            update() {},
            dispose() {},
        };
    }

    let created = false;
    let registry = readRegistry(ctx.ui);
    if (registry === undefined) {
        const enhancers = new Map<PropertyKey, EnhancerEntry<Args, Editor>>();
        const createdRegistry: EditorEnhancerRegistry<Args, Editor> = {
            [EDITOR_ENHANCER_PROTOCOL]: EDITOR_ENHANCER_PROTOCOL_VERSION,
            baseFactory: ctx.ui.getEditorComponent(),
            defaultFactory: createDefaultEditor,
            enhancers,
            factory: (...args: Args): Editor => {
                let editor =
                    createdRegistry.baseFactory?.(...args) ??
                    createdRegistry.defaultFactory(...args);
                for (const entry of enhancers.values()) {
                    editor = entry.enhancer(editor, ...args);
                }

                return editor;
            },
        };

        markSharedFactory(createdRegistry, ctx.ui);

        if (
            !Reflect.defineProperty(ctx.ui, EDITOR_ENHANCER_REGISTRY, {
                configurable: true,
                value: createdRegistry,
            })
        ) {
            throw new TypeError("Unable to store the editor enhancer registry");
        }

        registry = createdRegistry;
        created = true;
    }

    const previousEntry = registry.enhancers.get(key);
    const previousBase = registry.baseFactory;
    const entry: EnhancerEntry<Args, Editor> = { enhancer };
    registry.enhancers.set(key, entry);

    try {
        activateRegistry(ctx.ui, registry);
    } catch (cause: unknown) {
        if (previousEntry === undefined) registry.enhancers.delete(key);
        else registry.enhancers.set(key, previousEntry);

        registry.baseFactory = previousBase;

        if (
            created &&
            getOwnDataDescriptor(ctx.ui, EDITOR_ENHANCER_REGISTRY)?.value === registry &&
            !Reflect.deleteProperty(ctx.ui, EDITOR_ENHANCER_REGISTRY)
        ) {
            throw new TypeError("Unable to roll back the editor enhancer registry", { cause });
        }

        if (cause instanceof Error) {
            throw cause;
        }

        throw new Error("Unable to activate the editor enhancer registry", { cause });
    }

    let disposed = false;

    return {
        update(nextEnhancer): void {
            if (disposed || registry.enhancers.get(key) !== entry) {
                return;
            }

            const previousEnhancer = entry.enhancer;
            const previousBase = registry.baseFactory;
            entry.enhancer = nextEnhancer;

            try {
                activateRegistry(ctx.ui, registry);
            } catch (cause: unknown) {
                entry.enhancer = previousEnhancer;
                registry.baseFactory = previousBase;
                throw cause;
            }
        },
        dispose(): void {
            if (disposed) {
                return;
            }

            if (registry.enhancers.get(key) !== entry) {
                disposed = true;
                return;
            }

            if (registry.enhancers.size !== 1) {
                const previousEntries = new Map(registry.enhancers);

                registry.enhancers.delete(key);

                try {
                    if (isCurrentSharedFactory(ctx.ui.getEditorComponent(), registry)) {
                        activateRegistry(ctx.ui, registry);
                    }
                } catch (cause: unknown) {
                    registry.enhancers.clear();

                    for (const [previousKey, previousEntry] of previousEntries) {
                        registry.enhancers.set(previousKey, previousEntry);
                    }

                    throw cause;
                }

                disposed = true;
                return;
            }

            if (isCurrentSharedFactory(ctx.ui.getEditorComponent(), registry)) {
                ctx.ui.setEditorComponent(registry.baseFactory);
            }

            removeRegistry(ctx.ui, registry);

            registry.enhancers.delete(key);
            disposed = true;
        },
    };
}
