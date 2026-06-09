import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPiTypedCommandsSettings } from "./settings.js";
import type { ArgumentDefinitions, RegisteredTypedCommand, TypedCommandToggle } from "./types.js";

type RegistryListener = () => void;

type TypedCommandRegistry = {
    commands: Map<string, RegisteredTypedCommand>;
    listeners: Set<RegistryListener>;
};

const REGISTRY_KEY = Symbol.for("pi-typed-commands.registry");

type GlobalWithRegistry = typeof globalThis & {
    [REGISTRY_KEY]?: TypedCommandRegistry;
};

function createRegistry(): TypedCommandRegistry {
    return {
        commands: new Map<string, RegisteredTypedCommand>(),
        listeners: new Set<RegistryListener>(),
    };
}

/**
 * Return the process-wide typed command registry.
 *
 * @internal Prefer `getTypedCommand` or `getTypedCommands` unless you are extending this package.
 */
export function getTypedCommandRegistry(): TypedCommandRegistry {
    const globalObject = globalThis as GlobalWithRegistry;
    let registry = globalObject[REGISTRY_KEY];
    if (registry === undefined) {
        registry = createRegistry();
        globalObject[REGISTRY_KEY] = registry;
    }
    return registry;
}

/**
 * Store normalized typed command metadata and notify registry listeners.
 *
 * @internal `registerTypedCommand` calls this automatically.
 */
function notifyRegistryListeners(registry: TypedCommandRegistry): void {
    for (const listener of registry.listeners) {
        listener();
    }
}

export function registerTypedCommandMetadata<TDefinitions extends ArgumentDefinitions>(
    command: RegisteredTypedCommand<TDefinitions>,
): void {
    const registry = getTypedCommandRegistry();
    registry.commands.set(command.name, command as RegisteredTypedCommand);
    notifyRegistryListeners(registry);
}

/** Store typed skill metadata under its `skill:<name>` invocation. */
export function registerTypedSkillMetadata(command: RegisteredTypedCommand): void {
    const registry = getTypedCommandRegistry();
    registry.commands.set(command.name, command);
    notifyRegistryListeners(registry);
}

/** Replace all typed skill records while preserving extension-registered typed commands. */
export function replaceTypedSkillMetadata(commands: RegisteredTypedCommand[]): void {
    const registry = getTypedCommandRegistry();
    for (const [name, command] of registry.commands) {
        if ((command as { source?: unknown }).source === "skill" || name.startsWith("skill:")) {
            registry.commands.delete(name);
        }
    }
    for (const command of commands) {
        registry.commands.set(command.name, command);
    }
    notifyRegistryListeners(registry);
}

/** Look up a registered typed command by slash command name, without the leading `/`. */
export function getTypedCommand(name: string): RegisteredTypedCommand | undefined {
    return getTypedCommandRegistry().commands.get(name);
}

/** Return all registered typed commands sorted by command name. */
export function getTypedCommands(): RegisteredTypedCommand[] {
    return [...getTypedCommandRegistry().commands.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
    );
}

/**
 * Resolve a typed command toggle, treating thrown errors as disabled.
 *
 * @internal Exposed for package internals and advanced integrations.
 */
export function isToggleEnabled(
    toggle: TypedCommandToggle | undefined,
    ctx?: ExtensionContext,
): boolean {
    if (toggle === undefined) {
        return true;
    }
    if (typeof toggle === "boolean") {
        return toggle;
    }
    try {
        return toggle(ctx);
    } catch {
        return false;
    }
}

/**
 * Resolve global settings and per-command toggle state for a registered typed command.
 *
 * @internal Exposed for package internals and advanced integrations.
 */
export function isTypedCommandEnabled<TDefinitions extends ArgumentDefinitions>(
    command: RegisteredTypedCommand<TDefinitions>,
    ctx?: ExtensionContext,
    cwd?: string,
): boolean {
    if (!getPiTypedCommandsSettings(cwd ?? ctx?.cwd).enabled) {
        return false;
    }
    return isToggleEnabled(command.typedArgsEnabled, ctx);
}

/**
 * Subscribe to typed command registry changes.
 *
 * Returns an unsubscribe callback.
 *
 * @internal Used by the live editor helper to refresh when commands are registered.
 */
export function onTypedCommandsChanged(listener: RegistryListener): () => void {
    const registry = getTypedCommandRegistry();
    registry.listeners.add(listener);
    return () => {
        registry.listeners.delete(listener);
    };
}
