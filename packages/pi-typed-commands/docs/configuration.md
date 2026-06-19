# Configuration and Package Notes

Pi Typed Commands is a library for Pi extensions. Runtime behavior can be controlled globally, per project, or per command.

## Settings

Disable typed arguments globally:

```json
{
  "piTypedCommands": {
    "enabled": false
  }
}
```

Hide only the live helper/autocomplete UX:

```json
{
  "piTypedCommands": {
    "uxEnabled": false
  }
}
```

Show primitive types in the helper line:

```json
{
  "piTypedCommands": {
    "uxShowTypes": true
  }
}
```

Settings are read from Pi settings locations and can be overridden by environment variables.

## Environment overrides

| Variable                            | Effect                               |
| ----------------------------------- | ------------------------------------ |
| `PI_TYPED_COMMANDS=0`               | Disable typed command behavior.      |
| `PI_TYPED_COMMANDS_UX=0`            | Disable helper/autocomplete UX only. |
| `PI_TYPED_COMMANDS_UX_SHOW_TYPES=1` | Show primitive types in helper text. |

## Per-command migration controls

Use these options when moving an existing raw-argument command to typed arguments:

```ts
registerTypedCommand(pi, "legacy", {
  description: "Legacy-compatible command",
  args: { path: { type: "string" } },
  typedArgsEnabled: true,
  shouldUseTypedArgs(rawArgs, ctx) {
    return !rawArgs.startsWith("--legacy-mode");
  },
  fallbackHandler(rawArgs, ctx) {
    // Existing raw parser.
  },
  handler(args, ctx) {
    // New typed path.
  },
});
```

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
