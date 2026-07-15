import type { TypedSkillDiagnostics } from "./skills/types.js";
import type { ArgumentDefinitions, RegisteredTypedCommand } from "./types.js";

export type TypedCommandRegistryListener = () => void;

type RegistrationRecord = {
    readonly id: symbol;
    readonly ownerId: symbol;
    readonly source: "extension" | "skill";
    readonly localName: string;
    readonly invocationName: string;
    readonly command: RegisteredTypedCommand;
};

/** Narrow command metadata lookup consumed by parsers, completions, and Pi UI adapters. */
export type TypedCommandLookup = {
    get(name: string): RegisteredTypedCommand | undefined;
    list(): readonly RegisteredTypedCommand[];
};

/** Narrow registry subscription consumed by live Pi UI sessions. */
export type TypedCommandSubscription = {
    onChanged(listener: TypedCommandRegistryListener): () => void;
};

export type RegisterTypedCommandMetadataOptions = {
    readonly invocationName?: string;
    readonly ownerId?: symbol;
    readonly id?: symbol;
};

const DEFAULT_OWNER_ID = Symbol("pi-typed-args.owner.default");

function commandWithRegistration(record: RegistrationRecord): RegisteredTypedCommand {
    return {
        ...record.command,
        invocationName: record.invocationName,
        registrationId: record.id,
        ownerId: record.ownerId,
    };
}

/**
 * Instance-owned typed-command metadata registry.
 *
 * Each instance is isolated. Pi's optional process-wide discovery is composed separately in the
 * Pi adapter so core consumers and tests never depend on ambient global state.
 */
export class TypedCommandRegistry implements TypedCommandLookup, TypedCommandSubscription {
    readonly #commands = new Map<string, RegistrationRecord>();
    readonly #records = new Map<symbol, RegistrationRecord>();
    readonly #skillDiagnostics = new Map<string, TypedSkillDiagnostics>();
    readonly #listeners = new Set<TypedCommandRegistryListener>();

    register<TDefinitions extends ArgumentDefinitions>(
        command: RegisteredTypedCommand<TDefinitions>,
        options: RegisterTypedCommandMetadataOptions = {},
    ): string {
        this.removeExisting(command);

        const id = options.id ?? Symbol(command.name);
        const ownerId = options.ownerId ?? DEFAULT_OWNER_ID;
        const invocationName = options.invocationName ?? this.nextInvocationName(command.name);
        const record: RegistrationRecord = {
            id,
            ownerId,
            source: command.source ?? "extension",
            localName: command.name,
            invocationName,
            command,
        };

        this.#records.set(id, record);
        this.#commands.set(invocationName, record);
        this.notifyListeners();
        return invocationName;
    }

    unregister<TDefinitions extends ArgumentDefinitions>(
        command: RegisteredTypedCommand<TDefinitions>,
    ): void {
        const record = this.findExisting(command);
        if (record === undefined) {
            return;
        }
        this.deleteRecord(record);
        this.notifyListeners();
    }

    replaceSkills(
        commands: readonly RegisteredTypedCommand[],
        diagnostics: readonly TypedSkillDiagnostics[] = [],
    ): void {
        for (const record of this.#records.values()) {
            if (record.source === "skill") {
                this.deleteRecord(record);
            }
        }
        this.#skillDiagnostics.clear();
        for (const command of commands) {
            this.register(command, { invocationName: command.name });
        }
        for (const diagnostic of diagnostics) {
            this.#skillDiagnostics.set(`skill:${diagnostic.name}`, diagnostic);
        }
        this.notifyListeners();
    }

    get(name: string): RegisteredTypedCommand | undefined {
        const record = this.#commands.get(name);
        if (record === undefined) {
            return undefined;
        }
        return commandWithRegistration(record);
    }

    list(): readonly RegisteredTypedCommand[] {
        return [...this.#commands.values()]
            .map(commandWithRegistration)
            .sort((left, right) =>
                (left.invocationName ?? left.name).localeCompare(
                    right.invocationName ?? right.name,
                ),
            );
    }

    getSkillDiagnostics(name: string): TypedSkillDiagnostics | undefined {
        return this.#skillDiagnostics.get(name);
    }

    onChanged(listener: TypedCommandRegistryListener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    private notifyListeners(): void {
        for (const listener of this.#listeners) {
            listener();
        }
    }

    private nextInvocationName(localName: string): string {
        if (!this.#commands.has(localName)) {
            return localName;
        }
        let suffix = 1;
        while (this.#commands.has(`${localName}:${suffix}`)) {
            suffix += 1;
        }
        return `${localName}:${suffix}`;
    }

    private findExisting(command: RegisteredTypedCommand): RegistrationRecord | undefined {
        if (command.registrationId !== undefined) {
            return this.#records.get(command.registrationId);
        }
        for (const record of this.#records.values()) {
            if (record.command === command) {
                return record;
            }
        }
        return undefined;
    }

    private removeExisting(command: RegisteredTypedCommand): void {
        const record = this.findExisting(command);
        if (record !== undefined) {
            this.deleteRecord(record);
        }
    }

    private deleteRecord(record: RegistrationRecord): void {
        if (this.#commands.get(record.invocationName) === record) {
            this.#commands.delete(record.invocationName);
        }
        this.#records.delete(record.id);
    }
}

/** Create an isolated command registry for an application composition root or test. */
export function createTypedCommandRegistry(): TypedCommandRegistry {
    return new TypedCommandRegistry();
}
