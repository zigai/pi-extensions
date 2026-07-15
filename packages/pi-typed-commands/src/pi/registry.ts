import { createTypedCommandRegistry, type TypedCommandRegistry } from "../registry.js";
import type { RegisteredTypedCommand } from "./command-types.js";

const PI_REGISTRY_KEY = Symbol.for("pi-typed-args.registry.v2");

type GlobalWithPiRegistry = typeof globalThis & {
    [PI_REGISTRY_KEY]?: TypedCommandRegistry;
};

/** Pi composition adapter for cross-extension command metadata discovery. */
export function getPiTypedCommandRegistry(): TypedCommandRegistry {
    const globalObject: GlobalWithPiRegistry = globalThis;
    let registry = globalObject[PI_REGISTRY_KEY];
    if (registry === undefined) {
        registry = createTypedCommandRegistry();
        globalObject[PI_REGISTRY_KEY] = registry;
    }
    return registry;
}

/** Look up Pi-composed typed command metadata by slash command name. */
export function getTypedCommand(name: string): RegisteredTypedCommand | undefined {
    return getPiTypedCommandRegistry().get(name);
}

/** Return all Pi-composed typed commands sorted by invocation name. */
export function getTypedCommands(): readonly RegisteredTypedCommand[] {
    return getPiTypedCommandRegistry().list();
}
