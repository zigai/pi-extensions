import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPiCommandArgsSettings } from "./settings.js";
import type { ArgumentDefinitions, RegisteredTypedCommand, TypedCommandToggle } from "./types.js";

type RegistryListener = () => void;

type TypedCommandRegistry = {
    commands: Map<string, RegisteredTypedCommand>;
    listeners: Set<RegistryListener>;
};

const REGISTRY_KEY = Symbol.for("pi-command-args.registry");

type GlobalWithRegistry = typeof globalThis & {
    [REGISTRY_KEY]?: TypedCommandRegistry;
};

function createRegistry(): TypedCommandRegistry {
    return {
        commands: new Map<string, RegisteredTypedCommand>(),
        listeners: new Set<RegistryListener>(),
    };
}

export function getTypedCommandRegistry(): TypedCommandRegistry {
    const globalObject = globalThis as GlobalWithRegistry;
    let registry = globalObject[REGISTRY_KEY];
    if (registry === undefined) {
        registry = createRegistry();
        globalObject[REGISTRY_KEY] = registry;
    }
    return registry;
}

export function registerTypedCommandMetadata<TDefinitions extends ArgumentDefinitions>(
    command: RegisteredTypedCommand<TDefinitions>,
): void {
    const registry = getTypedCommandRegistry();
    registry.commands.set(command.name, command as RegisteredTypedCommand);
    for (const listener of registry.listeners) {
        listener();
    }
}

export function getTypedCommand(name: string): RegisteredTypedCommand | undefined {
    return getTypedCommandRegistry().commands.get(name);
}

export function getTypedCommands(): RegisteredTypedCommand[] {
    return [...getTypedCommandRegistry().commands.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
    );
}

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

export function isTypedCommandEnabled<TDefinitions extends ArgumentDefinitions>(
    command: RegisteredTypedCommand<TDefinitions>,
    ctx?: ExtensionContext,
    cwd?: string,
): boolean {
    if (!getPiCommandArgsSettings(cwd ?? ctx?.cwd).enabled) {
        return false;
    }
    return isToggleEnabled(command.typedArgsEnabled, ctx);
}

export function onTypedCommandsChanged(listener: RegistryListener): () => void {
    const registry = getTypedCommandRegistry();
    registry.listeners.add(listener);
    return () => {
        registry.listeners.delete(listener);
    };
}
