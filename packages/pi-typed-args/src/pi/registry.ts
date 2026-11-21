import { createTypedCommandRegistry, type TypedCommandRegistry } from "../registry.ts";
import type { RegisteredTypedCommand } from "./command-types.ts";

const PI_REGISTRY_KEY = Symbol.for("pi-typed-args.registry.v2");

type GlobalWithPiRegistry = typeof globalThis & {
    [PI_REGISTRY_KEY]?: TypedCommandRegistry;
};

export function getPiTypedCommandRegistry(): TypedCommandRegistry {
    const globalObject: GlobalWithPiRegistry = globalThis;
    let registry = globalObject[PI_REGISTRY_KEY];
    if (registry === undefined) {
        registry = createTypedCommandRegistry();
        globalObject[PI_REGISTRY_KEY] = registry;
    }

    return registry;
}

export function getTypedCommand(name: string): RegisteredTypedCommand | undefined {
    return getPiTypedCommandRegistry().get(name);
}

export function getTypedCommands(): readonly RegisteredTypedCommand[] {
    return getPiTypedCommandRegistry().list();
}
