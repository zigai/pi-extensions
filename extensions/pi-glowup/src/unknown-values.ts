import Type from "typebox";
import { Value } from "typebox/value";

const hostRecordSchema = Type.Object({});

export type HostValue =
    | string
    | number
    | boolean
    | bigint
    | symbol
    | null
    | undefined
    | HostRecord
    | ReadonlyArray<HostValue>
    | ((...args: ReadonlyArray<HostValue>) => HostValue);

export interface HostRecord {
    readonly [key: string]: HostValue;
}

export const hostRecordParser = {
    parse(value: unknown): HostRecord | undefined {
        if (!Value.Check(hostRecordSchema, value) || Array.isArray(value)) return undefined;
        const record: unknown = value;
        // SAFETY: Value.Check proves an object with string-keyed host-owned values; arrays are excluded.
        return record as HostRecord;
    },
};

export function isRecord<T>(value: T): value is T & HostRecord {
    return hostRecordParser.parse(value) !== undefined;
}

const stringSchema = Type.String();

export function getString(record: HostRecord, key: string): string | undefined {
    const value = record[key];
    return Value.Check(stringSchema, value) ? value : undefined;
}

export function stringField(value: HostValue, key: string): string | undefined {
    const record = hostRecordParser.parse(value);
    return record === undefined ? undefined : getString(record, key);
}
