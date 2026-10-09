import { matchesKey } from "@earendil-works/pi-tui";

/** Match extension-configured identifiers with Pi's own runtime key grammar. */
export function matchesRuntimeKey(data: string, keyId: string): boolean {
    // Pi 0.84.4 keys.js parseKeyId lowercases and splits arbitrary strings; empty
    // or unrecognized keys return false. KeyId in keys.d.ts is an autocomplete
    // convenience, not the runtime grammar (uppercase and repeated modifiers work).
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Both arguments are strings and Pi's installed matchesKey implementation accepts arbitrary identifier strings and returns boolean; its KeyId declaration cannot express that runtime grammar.
    const match = matchesKey as (data: string, keyId: string) => boolean;
    return match(data, keyId);
}
