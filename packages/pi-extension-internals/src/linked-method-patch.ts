const PATCH_PREDECESSOR = Symbol.for("zigai.pi-tweaks.render-patch-predecessor");
const PATCH_PREDECESSOR_DESCRIPTOR = Symbol.for(
    "zigai.pi-tweaks.render-patch-predecessor-descriptor",
);

const PATCH_PROTOCOL_VERSION = 1;
const PATCH_PROTOCOL = Symbol.for("zigai.pi-tweaks.render-patch-protocol-version");

export type LinkedMethod<Instance, Args extends unknown[], Result> = (
    this: Instance,
    ...args: Args
) => Result;

export type LinkedMethodPatchHandle<Instance, Args extends unknown[], Result> = {
    readonly predecessor: LinkedMethod<Instance, Args, Result>;
    readonly patched: LinkedMethod<Instance, Args, Result>;
    dispose(): void;
};

type MethodInstance<Target, Method> = Method extends (
    this: infer Instance,
    ...args: infer _Args
) => infer _Result
    ? unknown extends Instance
        ? Target
        : Instance
    : never;

type MethodArgs<Method> = Method extends (
    this: infer _Instance,
    ...args: infer Args
) => infer _Result
    ? Args
    : never;

type MethodResult<Method> = Method extends (
    this: infer _Instance,
    ...args: infer _Args
) => infer Result
    ? Result
    : never;

type ExtractedLinkedMethod<Target, Method> = LinkedMethod<
    MethodInstance<Target, Method>,
    MethodArgs<Method>,
    MethodResult<Method>
>;

type UnknownDataDescriptor = Omit<PropertyDescriptor, "value"> & { readonly value: unknown };

function isUnknownDataDescriptor(
    descriptor: PropertyDescriptor | undefined,
): descriptor is UnknownDataDescriptor {
    return descriptor !== undefined && Object.hasOwn(descriptor, "value");
}

/** Reads untrusted metadata written by another bundled package copy. */
// oxlint-disable-next-line antislop/no-object-parameters -- Metadata may be attached to any callable object.
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

function getLinkedPredecessor<Instance, Args extends unknown[], Result>(
    method: LinkedMethod<Instance, Args, Result>,
): LinkedMethod<Instance, Args, Result> | undefined {
    const version = getOwnDataDescriptor(method, PATCH_PROTOCOL)?.value;
    if (version !== undefined && version !== PATCH_PROTOCOL_VERSION) {
        let versionLabel = `invalid-${Object.prototype.toString.call(version).slice(8, -1).toLowerCase()}`;
        if (isNumber(version)) versionLabel = version.toString();
        throw new Error(`Unsupported linked method patch protocol version ${versionLabel}`);
    }

    const predecessor = getOwnDataDescriptor(method, PATCH_PREDECESSOR)?.value;
    if (typeof predecessor !== "function") {
        return undefined;
    }

    // SAFETY: installLinkedMethodPatch writes only a method with the same signature under
    // this process-wide symbol, and the runtime check proves the reflected value is callable.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: The versioned linked-patch protocol stores the same method signature; the callable check validates the reflected value, but TypeScript cannot retain generics through symbol descriptors.
    return predecessor as LinkedMethod<Instance, Args, Result>;
}

function getPredecessorDescriptor<Instance, Args extends unknown[], Result>(
    method: LinkedMethod<Instance, Args, Result>,
): PropertyDescriptor | undefined {
    const descriptor = getOwnDataDescriptor(method, PATCH_PREDECESSOR_DESCRIPTOR)?.value;
    if (descriptor === undefined) return undefined;

    if (!isNonNullObject(descriptor)) {
        throw new Error("Linked method patch has invalid predecessor descriptor metadata");
    }

    return descriptor;
}

function defineLinkedMetadata<Instance, Args extends unknown[], Result>(
    method: LinkedMethod<Instance, Args, Result>,
    predecessor: LinkedMethod<Instance, Args, Result>,
    predecessorDescriptor: PropertyDescriptor | undefined,
    key: PropertyKey,
): void {
    const metadata: ReadonlyArray<readonly [symbol, PropertyDescriptor]> = [
        [PATCH_PREDECESSOR, { configurable: true, value: predecessor, writable: true }],
        [
            PATCH_PREDECESSOR_DESCRIPTOR,
            { configurable: true, value: predecessorDescriptor, writable: true },
        ],
        [PATCH_PROTOCOL, { configurable: true, value: PATCH_PROTOCOL_VERSION }],
    ];
    for (const [metadataKey, descriptor] of metadata) {
        if (!Reflect.defineProperty(method, metadataKey, descriptor)) {
            Reflect.deleteProperty(method, PATCH_PREDECESSOR);
            Reflect.deleteProperty(method, PATCH_PREDECESSOR_DESCRIPTOR);
            Reflect.deleteProperty(method, PATCH_PROTOCOL);

            throw new TypeError(`Unable to attach linked patch metadata for ${String(key)}`);
        }
    }
}

function updateLinkedPredecessor<Instance, Args extends unknown[], Result>(
    method: LinkedMethod<Instance, Args, Result>,
    predecessor: LinkedMethod<Instance, Args, Result>,
    predecessorDescriptor: PropertyDescriptor | undefined,
): void {
    if (
        !Reflect.set(method, PATCH_PREDECESSOR, predecessor) ||
        !Reflect.set(method, PATCH_PREDECESSOR_DESCRIPTOR, predecessorDescriptor)
    ) {
        throw new Error("Unable to rewire linked method patch predecessor");
    }
}

/**
 * Installs one removable method transform whose predecessor remains dynamically linked.
 *
 * This low-level operation intentionally installs a new layer on every call. Use
 * `installKeyedLinkedMethodPatch` when an extension needs idempotent reload behavior.
 * Independent layers may be disposed in any order without retaining stale closures.
 */
export function installLinkedMethodPatch<Target extends object, Key extends keyof Target>(
    target: Target,
    key: Key,
    transform: (
        predecessor: ExtractedLinkedMethod<Target, Target[Key]>,
    ) => ExtractedLinkedMethod<Target, Target[Key]>,
): LinkedMethodPatchHandle<
    MethodInstance<Target, Target[Key]>,
    MethodArgs<Target[Key]>,
    MethodResult<Target[Key]>
> {
    type Instance = MethodInstance<Target, Target[Key]>;
    type Args = MethodArgs<Target[Key]>;
    type Result = MethodResult<Target[Key]>;
    type Method = LinkedMethod<Instance, Args, Result>;

    const candidate: unknown = target[key];
    if (typeof candidate !== "function") {
        throw new TypeError(`Unable to patch non-function property ${String(key)}`);
    }

    // SAFETY: Target[Key] determines Method's this, arguments, and result types, while the
    // runtime check proves the indexed value is callable. TypeScript cannot retain that
    // conditional relationship after narrowing an indexed generic property.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Target[Key] supplies the exact method signature and candidate is checked callable; TypeScript loses that conditional indexed relationship after the unknown boundary.
    const original = candidate as Method;
    const originalDescriptor = Object.getOwnPropertyDescriptor(target, key);
    let patched: Method;
    const dynamicPredecessor: Method = function (this: Instance, ...args: Args): Result {
        const predecessor = getLinkedPredecessor(patched);
        if (predecessor === undefined) {
            throw new Error("Linked method patch lost its predecessor");
        }

        return predecessor.apply(this, args);
    };

    const transformed = transform(dynamicPredecessor);
    if (typeof transformed !== "function") {
        throw new TypeError(`Method transform for ${String(key)} returned a non-function`);
    }

    patched = transformed;
    if (
        patched === original ||
        Object.hasOwn(patched, PATCH_PREDECESSOR) ||
        Object.hasOwn(patched, PATCH_PREDECESSOR_DESCRIPTOR) ||
        Object.hasOwn(patched, PATCH_PROTOCOL)
    ) {
        throw new TypeError(`Method transform for ${String(key)} returned an installed method`);
    }

    if (!Object.isExtensible(patched)) {
        throw new TypeError(
            `Method transform for ${String(key)} returned a non-extensible function`,
        );
    }

    defineLinkedMetadata(patched, original, originalDescriptor, key);

    let installed = false;

    try {
        installed = Reflect.set(target, key, patched) && target[key] === patched;
    } finally {
        if (!installed) {
            Reflect.deleteProperty(patched, PATCH_PREDECESSOR);
            Reflect.deleteProperty(patched, PATCH_PREDECESSOR_DESCRIPTOR);
            Reflect.deleteProperty(patched, PATCH_PROTOCOL);
        }
    }

    if (!installed) {
        throw new TypeError(`Unable to patch method ${String(key)}`);
    }

    let disposed = false;

    return {
        predecessor: original,
        patched,
        dispose(): void {
            if (disposed) return;

            const predecessor = getLinkedPredecessor(patched);
            if (predecessor === undefined) {
                throw new Error("Linked method patch lost its predecessor");
            }

            const predecessorDescriptor = getPredecessorDescriptor(patched);

            if (target[key] === patched) {
                let restored: boolean;
                if (predecessorDescriptor === undefined) {
                    restored = Reflect.deleteProperty(target, key);
                } else {
                    restored = Reflect.defineProperty(target, key, predecessorDescriptor);
                }

                if (!restored) {
                    throw new Error(`Unable to restore method ${String(key)}`);
                }

                disposed = true;
                return;
            }

            const successor: unknown = target[key];
            if (typeof successor !== "function") {
                disposed = true;
                return;
            }
            // SAFETY: A callable value at the patched key participates in the linked-method
            // protocol only through getLinkedPredecessor's symbol validation. This cast lets
            // that validation preserve Method's signature across the dynamically linked chain.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: This callable is only traversed through version-checked linked metadata, never invoked; TypeScript cannot carry the installed method's signature through a reflected successor.
            let current = successor as Method;
            const visited = new Set<Method>();
            for (;;) {
                if (visited.has(current)) {
                    throw new Error(
                        `Unable to dispose cyclic method patch chain for ${String(key)}`,
                    );
                }

                visited.add(current);

                const next = getLinkedPredecessor(current);
                if (next === undefined) {
                    disposed = true;
                    return;
                }

                if (next === patched) {
                    updateLinkedPredecessor(current, predecessor, predecessorDescriptor);
                    disposed = true;
                    return;
                }

                current = next;
            }
        },
    };
}

const KEYED_PATCH_PROTOCOL_VERSION = 1;
const KEYED_PATCH_PROTOCOL = Symbol.for("zigai.pi-tweaks.keyed-method-patch-protocol-version");

export type KeyedLinkedMethodPatchHandle<
    Policy,
    Instance,
    Args extends unknown[],
    Result,
> = LinkedMethodPatchHandle<Instance, Args, Result> & {
    update(policy: Policy): void;
};

type KeyedPatchRecord<Policy, Instance, Args extends unknown[], Result> = {
    readonly [KEYED_PATCH_PROTOCOL]: typeof KEYED_PATCH_PROTOCOL_VERSION;
    readonly methodKey: PropertyKey;
    readonly handle: KeyedLinkedMethodPatchHandle<Policy, Instance, Args, Result>;
};

// oxlint-disable-next-line antislop/no-object-parameters -- Protocol handles are structural objects from another bundle copy.
function hasOwnFunctionProperty(target: object, key: PropertyKey): boolean {
    return typeof getOwnDataDescriptor(target, key)?.value === "function";
}

/* oxlint-disable antislop/no-object-parameters -- This parses a protocol record created by another bundle copy. */
function readKeyedPatchHandle<Policy, Instance, Args extends unknown[], Result>(
    record: object,
    methodKey: PropertyKey,
): KeyedLinkedMethodPatchHandle<Policy, Instance, Args, Result> {
    const version = getOwnDataDescriptor(record, KEYED_PATCH_PROTOCOL)?.value;
    if (version !== KEYED_PATCH_PROTOCOL_VERSION) {
        let versionLabel = `invalid-${Object.prototype.toString.call(version).slice(8, -1).toLowerCase()}`;
        if (isNumber(version)) versionLabel = version.toString();
        throw new TypeError(`Unsupported keyed method patch protocol version ${versionLabel}`);
    }

    if (getOwnDataDescriptor(record, "methodKey")?.value !== methodKey) {
        throw new TypeError("Keyed method patch marker is already used for another method");
    }

    const handle = getOwnDataDescriptor(record, "handle")?.value;
    if (
        !isNonNullObject(handle) ||
        !hasOwnFunctionProperty(handle, "predecessor") ||
        !hasOwnFunctionProperty(handle, "patched") ||
        !hasOwnFunctionProperty(handle, "update") ||
        !hasOwnFunctionProperty(handle, "dispose")
    ) {
        throw new TypeError("Incompatible keyed method patch handle");
    }
    // SAFETY: The shared record version and complete callable handle shape were validated.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Protocol version, method key and every callable handle member are validated; the globally keyed installer owns the policy/signature relationship that TypeScript cannot recover from descriptors.
    return handle as KeyedLinkedMethodPatchHandle<Policy, Instance, Args, Result>;
}
/* oxlint-enable antislop/no-object-parameters */

/**
 * Installs or updates one globally keyed linked method patch.
 *
 * The marker must come from `Symbol.for(...)`. Reinstalling the same marker updates its policy
 * without adding another method layer, including when another bundled package copy installed it.
 */
export function installKeyedLinkedMethodPatch<
    Target extends object,
    Key extends keyof Target,
    Policy,
>(
    target: Target,
    key: Key,
    marker: symbol,
    initialPolicy: Policy,
    transform: (
        predecessor: ExtractedLinkedMethod<Target, Target[Key]>,
        getPolicy: () => Policy,
    ) => ExtractedLinkedMethod<Target, Target[Key]>,
): KeyedLinkedMethodPatchHandle<
    Policy,
    MethodInstance<Target, Target[Key]>,
    MethodArgs<Target[Key]>,
    MethodResult<Target[Key]>
> {
    if (Symbol.keyFor(marker) === undefined) {
        throw new TypeError("Keyed method patch markers must be created with Symbol.for(...)");
    }

    type Instance = MethodInstance<Target, Target[Key]>;
    type Args = MethodArgs<Target[Key]>;
    type Result = MethodResult<Target[Key]>;

    const installedRecord = getOwnDataDescriptor(target, marker)?.value;
    if (installedRecord !== undefined) {
        if (!isNonNullObject(installedRecord)) {
            throw new TypeError("Incompatible keyed method patch record");
        }

        const handle = readKeyedPatchHandle<Policy, Instance, Args, Result>(installedRecord, key);
        handle.update(initialPolicy);

        return handle;
    }

    let currentPolicy = initialPolicy;
    const patch = installLinkedMethodPatch(target, key, (predecessor) =>
        transform(predecessor, () => currentPolicy),
    );
    let disposed = false;
    let record: KeyedPatchRecord<Policy, Instance, Args, Result>;
    const handle: KeyedLinkedMethodPatchHandle<Policy, Instance, Args, Result> = {
        predecessor: patch.predecessor,
        patched: patch.patched,
        update(policy): void {
            if (!disposed) currentPolicy = policy;
        },
        dispose(): void {
            if (disposed) return;

            patch.dispose();

            if (
                getOwnDataDescriptor(target, marker)?.value === record &&
                !Reflect.deleteProperty(target, marker)
            ) {
                throw new TypeError(`Unable to remove keyed method patch ${String(marker)}`);
            }

            disposed = true;
        },
    };

    record = {
        [KEYED_PATCH_PROTOCOL]: KEYED_PATCH_PROTOCOL_VERSION,
        methodKey: key,
        handle,
    };
    if (
        !Reflect.defineProperty(target, marker, {
            configurable: true,
            value: record,
        })
    ) {
        patch.dispose();
        throw new TypeError(`Unable to store keyed method patch ${String(marker)}`);
    }

    return handle;
}

export function installLinkedRenderPatch<Target extends object & { render: unknown }>(
    target: Target,
    transform: (
        predecessor: ExtractedLinkedMethod<Target, Target["render"]>,
    ) => ExtractedLinkedMethod<Target, Target["render"]>,
): LinkedMethodPatchHandle<
    MethodInstance<Target, Target["render"]>,
    MethodArgs<Target["render"]>,
    MethodResult<Target["render"]>
> {
    return installLinkedMethodPatch(target, "render", transform);
}
