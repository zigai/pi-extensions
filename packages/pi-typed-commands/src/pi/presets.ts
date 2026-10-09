import { randomUUID } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import Type, { type Static } from "typebox";
import Schema from "../typebox-schema.js";
import { validateArgumentValue } from "../schema.js";
import type { ArgumentValue } from "../types.js";
import type { RegisteredTypedCommand } from "./command-types.js";

const StoredArgumentValueSchema = Type.Union([
    Type.String(),
    Type.Number(),
    Type.Boolean(),
    Type.Array(Type.String()),
    Type.Record(Type.String(), Type.String()),
]);
const StoredValuesSchema = Type.Record(Type.String(), StoredArgumentValueSchema);
const PresetStoreSchema = Type.Object(
    {
        version: Type.Literal(1),
        commands: Type.Record(
            Type.String(),
            Type.Object({
                recent: Type.Optional(StoredValuesSchema),
                presets: Type.Record(Type.String(), StoredValuesSchema),
            }),
        ),
    },
    { additionalProperties: false },
);

type PresetStore = Static<typeof PresetStoreSchema>;
type StoredArgumentValue = Static<typeof StoredArgumentValueSchema>;

export type TypedCommandPresetCollection = {
    readonly recent?: Readonly<Record<string, ArgumentValue>>;
    readonly presets: Readonly<Record<string, Readonly<Record<string, ArgumentValue>>>>;
};

export type TypedCommandPresetContext = {
    readonly cwd: string;
    isProjectTrusted(): boolean;
};

type MutableTypedCommandPresetCollection = {
    recent?: Readonly<Record<string, ArgumentValue>>;
    presets: Readonly<Record<string, Readonly<Record<string, ArgumentValue>>>>;
};

type PresetStoreRead =
    | { readonly status: "ok"; readonly path: string; readonly store: PresetStore }
    | { readonly status: "malformed"; readonly path: string };

function presetStorePath(context: TypedCommandPresetContext): string {
    if (context.isProjectTrusted()) {
        return join(context.cwd, CONFIG_DIR_NAME, "pi-typed-args", "presets.json");
    }

    return join(getAgentDir(), "pi-typed-args", "presets.json");
}

function emptyStore(): PresetStore {
    return { version: 1, commands: {} };
}

function readPresetStore(context: TypedCommandPresetContext): PresetStoreRead {
    const path = presetStorePath(context);
    if (!existsSync(path)) {
        return { status: "ok", path, store: emptyStore() };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return { status: "malformed", path };
    }

    if (!Schema.Check(PresetStoreSchema, parsed)) {
        return { status: "malformed", path };
    }

    return { status: "ok", path, store: Schema.Parse(PresetStoreSchema, parsed) };
}

function writePresetStore(path: string, store: PresetStore): void {
    mkdirSync(dirname(path), { recursive: true });

    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    let replaced = false;
    let temporaryCreated = false;

    try {
        writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
            flag: "wx",
            mode: 0o600,
        });
        temporaryCreated = true;
        renameSync(temporaryPath, path);
        replaced = true;
    } finally {
        if (!replaced && temporaryCreated) {
            try {
                unlinkSync(temporaryPath);
            } catch {
                // Preserve the original write failure when temporary cleanup is also unavailable.
            }
        }
    }
}

function isStringArray(value: ArgumentValue): value is readonly string[] {
    return Array.isArray(value);
}

function safePresetValues(
    command: RegisteredTypedCommand,
    values: Readonly<Record<string, ArgumentValue>>,
) {
    const safe: Record<string, StoredArgumentValue> = {};
    for (const [name, definition] of Object.entries(command.args)) {
        if (definition.type === "string" && definition.sensitive === true) {
            continue;
        }

        const value = values[name];
        if (value === undefined) {
            continue;
        }

        const validation = validateArgumentValue(name, definition, value);
        if (!validation.ok) {
            continue;
        }

        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
            safe[name] = value;
        } else if (isStringArray(value)) {
            safe[name] = [...value];
        } else {
            safe[name] = { ...value };
        }
    }

    return safe;
}

function commandPresetKey(command: RegisteredTypedCommand): string {
    return command.name;
}

/** Load validated recent values and named presets for one command grammar. */
export function loadTypedCommandPresets(
    context: TypedCommandPresetContext,
    command: RegisteredTypedCommand,
): TypedCommandPresetCollection | undefined {
    const read = readPresetStore(context);
    if (read.status === "malformed") {
        return undefined;
    }

    const key = commandPresetKey(command);
    let stored: PresetStore["commands"][string] | undefined;
    if (Object.hasOwn(read.store.commands, key)) {
        stored = read.store.commands[key];
    }

    if (stored === undefined) {
        return { presets: {} };
    }

    const presets: Record<string, Readonly<Record<string, ArgumentValue>>> = Object.fromEntries(
        Object.entries(stored.presets).map(([name, values]) => [
            name,
            safePresetValues(command, values),
        ]),
    );
    const collection: MutableTypedCommandPresetCollection = { presets };
    if (stored.recent !== undefined) {
        collection.recent = safePresetValues(command, stored.recent);
    }

    return collection;
}

function updateTypedCommandPresets(
    context: TypedCommandPresetContext,
    command: RegisteredTypedCommand,
    update: (entry: PresetStore["commands"][string]) => void,
): boolean {
    const read = readPresetStore(context);
    if (read.status === "malformed") {
        return false;
    }

    const key = commandPresetKey(command);
    let existing: PresetStore["commands"][string] | undefined;
    if (Object.hasOwn(read.store.commands, key)) {
        existing = read.store.commands[key];
    }

    const entry: PresetStore["commands"][string] = {
        presets: { ...existing?.presets },
    };
    if (existing?.recent !== undefined) {
        entry.recent = { ...existing.recent };
    }

    update(entry);
    read.store.commands = { ...read.store.commands, [key]: entry };

    try {
        writePresetStore(read.path, read.store);
        return true;
    } catch {
        return false;
    }
}

/** Persist non-sensitive values as this command's project-scoped recent form state. */
export function recordTypedCommandRecentValues(
    context: TypedCommandPresetContext,
    command: RegisteredTypedCommand,
    values: Readonly<Record<string, ArgumentValue>>,
): boolean {
    const safe = safePresetValues(command, values);

    return updateTypedCommandPresets(context, command, (entry) => {
        entry.recent = safe;
    });
}

/** Save or replace one named, project-scoped, non-sensitive form preset. */
export function saveTypedCommandPreset(
    context: TypedCommandPresetContext,
    command: RegisteredTypedCommand,
    name: string,
    values: Readonly<Record<string, ArgumentValue>>,
): boolean {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
        return false;
    }

    const safe = safePresetValues(command, values);

    return updateTypedCommandPresets(context, command, (entry) => {
        entry.presets = { ...entry.presets, [trimmedName]: safe };
    });
}
