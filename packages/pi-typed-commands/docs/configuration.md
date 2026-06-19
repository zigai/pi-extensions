# Configuration and Package Notes

Pi Typed Commands is a library for Pi extensions and typed skills. When a command or skill uses this library, typed parsing, completions, editor hints, and argument forms are always active.

There are no environment variables, Pi settings, command options, or callbacks that disable or bypass those features.

## Package contract

Current package characteristics:

- distributed as a Git dependency, not as a published npm package;
- `private: true` in `package.json`;
- ESM package with TypeScript source exports;
- tested with `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` `^0.79.7`;
- public subpaths for core, Pi adapter, skills, TUI integration, and JSON Schema.

Because Pi can load TypeScript extension packages directly, source exports are sufficient for Pi usage. If this library is published for broader npm consumption later, it should ship built ESM output and declaration files.

## Compatibility notes

The preferred public API is definition-first:

```ts
const command = defineTypedCommand(...);
registerTypedCommand(pi, command);
```

Compatibility exports remain for migration:

- `RegisteredTypedCommand`
- `ParsedCommandArguments`
- legacy `positional`
- legacy registration overload `registerTypedCommand(pi, name, options)`

New code should prefer `DefinedTypedCommand`, `TypedParseResult`, `position`, and `defineTypedCommand()`.
