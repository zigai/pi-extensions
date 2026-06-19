import type { TypedSkillDiagnostics } from "./skills.js";
import type { ArgumentDefinitions, RegisteredTypedCommand } from "./types.js";

type RegistryListener = () => void;

type RegistrationRecord = {
    id: symbol;
    ownerId: symbol;
    source: "extension" | "skill";
    localName: string;
    invocationName: string;
    command: RegisteredTypedCommand;
};

type TypedCommandRegistry = {
    version: 1;
    commands: Map<string, RegisteredTypedCommand>;
    records: Map<symbol, RegistrationRecord>;
    skillDiagnostics: Map<string, TypedSkillDiagnostics>;
    listeners: Set<RegistryListener>;
};

const REGISTRY_KEY = Symbol.for("pi-typed-commands.registry.v1");
const DEFAULT_OWNER_ID = Symbol.for("pi-typed-commands.owner.default");

type GlobalWithRegistry = typeof globalThis & {
    [REGISTRY_KEY]?: TypedCommandRegistry;
};

function createRegistry(): TypedCommandRegistry {
    return {
        version: 1,
        commands: new Map<string, RegisteredTypedCommand>(),
        records: new Map<symbol, RegistrationRecord>(),
        skillDiagnostics: new Map<string, TypedSkillDiagnostics>(),
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

function notifyRegistryListeners(registry: TypedCommandRegistry): void {
    for (const listener of registry.listeners) {
        listener();
    }
}

function nextInvocationName(registry: TypedCommandRegistry, localName: string): string {
    if (!registry.commands.has(localName)) {
        return localName;
    }

    let suffix = 1;
    while (registry.commands.has(`${localName}:${suffix}`)) {
        suffix += 1;
    }
    return `${localName}:${suffix}`;
}

function removeExistingRecord(
    registry: TypedCommandRegistry,
    command: RegisteredTypedCommand,
): void {
    const id = command.registrationId;
    if (id === undefined) {
        return;
    }
    const record = registry.records.get(id);
    if (record === undefined) {
        return;
    }
    if (registry.commands.get(record.invocationName) === command) {
        registry.commands.delete(record.invocationName);
    }
    registry.records.delete(id);
}

export type RegisterTypedCommandMetadataOptions = {
    invocationName?: string;
    ownerId?: symbol;
    id?: symbol;
};

export function registerTypedCommandMetadata<TDefinitions extends ArgumentDefinitions>(
    command: RegisteredTypedCommand<TDefinitions>,
    options: RegisterTypedCommandMetadataOptions = {},
): string {
    const registry = getTypedCommandRegistry();
    removeExistingRecord(registry, command as RegisteredTypedCommand);

    const id = options.id ?? Symbol(command.name);
    const ownerId = options.ownerId ?? DEFAULT_OWNER_ID;
    const invocationName = options.invocationName ?? nextInvocationName(registry, command.name);
    const source = command.source ?? "extension";

    command.registrationId = id;
    command.ownerId = ownerId;
    command.invocationName = invocationName;

    registry.records.set(id, {
        id,
        ownerId,
        source,
        localName: command.name,
        invocationName,
        command: command as RegisteredTypedCommand,
    });
    registry.commands.set(invocationName, command as RegisteredTypedCommand);
    notifyRegistryListeners(registry);
    return invocationName;
}

/** Remove wrapper-owned metadata for a command if the same record is still registered. */
export function unregisterTypedCommandMetadata<TDefinitions extends ArgumentDefinitions>(
    command: RegisteredTypedCommand<TDefinitions>,
): void {
    const registry = getTypedCommandRegistry();
    const invocationName = command.invocationName ?? command.name;
    if (registry.commands.get(invocationName) !== command) {
        return;
    }
    registry.commands.delete(invocationName);
    if (command.registrationId !== undefined) {
        registry.records.delete(command.registrationId);
    }
    notifyRegistryListeners(registry);
}

/** Store typed skill metadata under its `skill:<name>` invocation. */
export function registerTypedSkillMetadata(command: RegisteredTypedCommand): void {
    registerTypedCommandMetadata(command, { invocationName: command.name });
}

/** Replace all typed skill records while preserving extension-registered typed commands. */
export function replaceTypedSkillMetadata(
    commands: RegisteredTypedCommand[],
    diagnostics: TypedSkillDiagnostics[] = [],
): void {
    const registry = getTypedCommandRegistry();
    const records = Array.from(registry.records.values());
    for (const record of records) {
        if (record.source === "skill") {
            registry.records.delete(record.id);
            if (registry.commands.get(record.invocationName) === record.command) {
                registry.commands.delete(record.invocationName);
            }
        }
    }
    registry.skillDiagnostics.clear();
    for (const command of commands) {
        registerTypedCommandMetadata(command, { invocationName: command.name });
    }
    for (const diagnostic of diagnostics) {
        registry.skillDiagnostics.set(`skill:${diagnostic.name}`, diagnostic);
    }
    notifyRegistryListeners(registry);
}

/** Look up a registered typed command by slash command name, without the leading `/`. */
export function getTypedCommand(name: string): RegisteredTypedCommand | undefined {
    return getTypedCommandRegistry().commands.get(name);
}

/** Look up typed skill metadata diagnostics by slash command name, without the leading `/`. */
export function getTypedSkillDiagnostics(name: string): TypedSkillDiagnostics | undefined {
    return getTypedCommandRegistry().skillDiagnostics.get(name);
}

/** Return all registered typed commands sorted by invocation name. */
export function getTypedCommands(): RegisteredTypedCommand[] {
    return [...getTypedCommandRegistry().commands.values()].sort((a, b) =>
        (a.invocationName ?? a.name).localeCompare(b.invocationName ?? b.name),
    );
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
