# Configuration and Package Notes

Pi Typed Commands is a library for Pi extensions and typed skills. When a command or skill uses this library, typed parsing, completions, editor hints, and argument forms are always active.

There are no environment variables, command options, or callbacks that disable or bypass those features.

## Live helper placement

The compact live helper is shown above the user input editor by default. Move it below the input editor with Pi settings:

```json
{
  "piTypedCommands": {
    "helperPlacement": "belowEditor"
  }
}
```

Project `.pi/settings.json` overrides global `~/.pi/agent/settings.json` when the project is trusted. Valid values are `"belowEditor"` and `"aboveEditor"`.

You can also pass the option when you compose the extension entrypoint yourself:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installTypedCommandUx } from "pi-typed-commands";

export default function extension(pi: ExtensionAPI): void {
  installTypedCommandUx(pi, { helperPlacement: "belowEditor" });
}
```

Explicit `installTypedCommandUx()` options override Pi settings.

## Package contract

Current package characteristics:

- distributed as a Git dependency until the first npm publication;
- ESM package with TypeScript source exports;
- tested with `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` `^0.79.7`;
- public subpaths for core, Pi adapter, skills, TUI integration, and JSON Schema.

Because Pi can load TypeScript extension packages directly, source exports are sufficient for Pi usage. Define commands once and register the definition or defined command with Pi:

```ts
const command = defineTypedCommand(...);
registerTypedCommand(pi, command);
```
