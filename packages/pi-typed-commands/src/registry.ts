import type { TypedSkillDiagnostics } from "./skills/types.js";
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
    commands: Map<string, RegistrationRecord>;
    records: Map<symbol, RegistrationRecord>;
    skillDiagnostics: Map<string, TypedSkillDiagnostics>;
    listeners: Set<RegistryListener>;
};

const REGISTRY_KEY = Symbol.for("pi-typed-args.registry.v1");
const DEFAULT_OWNER_ID = Symbol.for("pi-typed-args.owner.default");

type GlobalWithRegistry = typeof globalThis & {
    [REGISTRY_KEY]?: TypedCommandRegistry;
};

function createRegistry(): TypedCommandRegistry {
    return {
        version: 1,
        commands: new Map<string, RegistrationRecord>(),
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

function commandWithRegistration(record: RegistrationRecord): RegisteredTypedCommand {
    return {
        ...record.command,
        invocationName: record.invocationName,
        registrationId: record.id,
        ownerId: record.ownerId,
    };
}

function findExistingRecord(
    registry: TypedCommandRegistry,
    command: RegisteredTypedCommand,
): RegistrationRecord | undefined {
    const id = command.registrationId;
    if (id !== undefined) {
        return registry.records.get(id);
    }
    for (const record of registry.records.values()) {
        if (record.command === command) {
            return record;
        }
    }
    return undefined;
}

function removeExistingRecord(
    registry: TypedCommandRegistry,
    command: RegisteredTypedCommand,
): void {
    const record = findExistingRecord(registry, command);
    if (record === undefined) {
        return;
    }
    if (registry.commands.get(record.invocationName) === record) {
        registry.commands.delete(record.invocationName);
    }
    registry.records.delete(record.id);
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
    removeExistingRecord(registry, command);

    const id = options.id ?? Symbol(command.name);
    const ownerId = options.ownerId ?? DEFAULT_OWNER_ID;
    const invocationName = options.invocationName ?? nextInvocationName(registry, command.name);
    const source = command.source ?? "extension";

    const record: RegistrationRecord = {
        id,
        ownerId,
        source,
        localName: command.name,
        invocationName,
        command,
    };

    registry.records.set(id, record);
    registry.commands.set(invocationName, record);
    notifyRegistryListeners(registry);
    return invocationName;
}

/** Remove wrapper-owned metadata for a command if the same record is still registered. */
export function unregisterTypedCommandMetadata<TDefinitions extends ArgumentDefinitions>(
    command: RegisteredTypedCommand<TDefinitions>,
): void {
    const registry = getTypedCommandRegistry();
    const record = findExistingRecord(registry, command);
    if (record === undefined) {
        return;
    }
    if (registry.commands.get(record.invocationName) === record) {
        registry.commands.delete(record.invocationName);
    }
    registry.records.delete(record.id);
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
            if (registry.commands.get(record.invocationName) === record) {
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
    const record = getTypedCommandRegistry().commands.get(name);
    if (record === undefined) {
        return undefined;
    }
    return commandWithRegistration(record);
}

/** Look up typed skill metadata diagnostics by slash command name, without the leading `/`. */
export function getTypedSkillDiagnostics(name: string): TypedSkillDiagnostics | undefined {
    return getTypedCommandRegistry().skillDiagnostics.get(name);
}

/** Return all registered typed commands sorted by invocation name. */
export function getTypedCommands(): RegisteredTypedCommand[] {
    return [...getTypedCommandRegistry().commands.values()]
        .map(commandWithRegistration)
        .sort((a, b) => (a.invocationName ?? a.name).localeCompare(b.invocationName ?? b.name));
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
