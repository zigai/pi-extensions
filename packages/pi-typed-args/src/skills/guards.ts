/** Create a null-prototype record for user-controlled dotted skill argument paths. */
export function createSafeRecord<TValue = unknown>(): Record<string, TValue> {
    // SAFETY: Object.create(null) returns a mutable object with no inherited keys. The generic
    // value type is enforced at every assignment; TypeScript cannot type Object.create precisely.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the fresh empty null-prototype object is exposed only through this typed dictionary interface.
    return Object.create(null) as Record<string, TValue>;
}
