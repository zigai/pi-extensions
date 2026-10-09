# Local assertion exception ledger

## Runtime-configured key matching

- Rule: `typescript(no-unsafe-type-assertion)`.
- Site: `src/runtime-key-matching.ts`, the single callable-signature assertion.
- Guidance: `typescript(no-unsafe-type-assertion)` **Suppression**, documented dependency declaration defect/dynamic callable contract in its owning external adapter, with authoritative contract evidence, all available input checks, containment, and focused valid/malformed tests.
- Constraint: installed `@earendil-works/pi-tui` 0.84.4 `dist/keys.d.ts:30-42,165` restricts `matchesKey` to the autocomplete `KeyId` union. Its `dist/keys.js:603-614,633-638` instead parses arbitrary strings by lowercasing/splitting, returns false for empty identifiers, and its subsequent switch/default handles unknown keys without throwing. Uppercase and repeated modifiers are supported at runtime but not represented by the union. Restricting extension settings to that union would change existing matching behavior.
- Proof/containment: the adapter accepts only two TypeScript strings and statically imports the supported Pi function; no unknown module, private receiver, constructor, or unchecked returned object is involved. Therefore dynamic-export/constructability checks do not apply. The only assertion widens the function's accepted identifier grammar, not settings data or fixtures. The outward result remains boolean, as declared and implemented by Pi. Callers never receive the asserted callable.
- Evidence: `test/runtime-key-matching.test.ts` calls the installed runtime, checks typed-key parity, uppercase aliases, repeated modifiers, matching/nonmatching input, and empty/trailing-plus/unrecognized identifiers. Scoped full-rule lint with unused directives as errors, repository typecheck, and package tests pass.

No other assertion exceptions were introduced in this cleanup. Prototype patch hosts now expose methods/owned markers rather than asserting instance receiver state; existing runtime guards and patch lifecycle behavior are retained.
