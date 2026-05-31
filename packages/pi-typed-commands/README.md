# Pi Command Args

Typed named slash-command arguments with live hints and TUI prompts for Pi extensions.

## Install

```sh
pi install git:github.com/zigai/pi-command-args
```

For private/local startup without GitHub auth, reference the local clone from `~/.pi/agent/settings.json`:

```json
{
  "packages": ["/home/zigai/Projects/pi-command-args"]
}
```

## What It Adds

`pi-command-args` is both:

- a small library for extension authors to register typed named args; and
- a companion Pi extension that shows a one-line helper while typing typed commands.

The companion extension watches the editor and shows a compact hint for registered typed commands:

```text
/deploy --env <dev|staging|prod> [--ref <string=main>] [--dry-run]  ·  ? opens form
```

## Usage In Extensions

```ts
import { registerTypedCommand } from "pi-command-args";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  registerTypedCommand(pi, "deploy", {
    description: "Deploy a ref",
    args: {
      env: {
        type: "enum",
        values: ["dev", "staging", "prod"] as const,
        required: true,
        description: "Target environment",
      },
      ref: {
        type: "string",
        default: "main",
        description: "Git ref to deploy",
      },
      dryRun: {
        type: "boolean",
        description: "Preview without deploying",
      },
    },
    handler: async (args, ctx) => {
      ctx.ui.notify(`Deploy ${args.ref} to ${args.env}; dryRun=${String(args.dryRun)}`);
    },
  });
}
```

Fast path:

```text
/deploy --env staging --ref main --dry-run
```

Manual TUI prompt flow:

```text
/deploy ?
```

Detailed help:

```text
/deploy ??
```

If a required argument is missing or an argument is invalid, the command opens the TUI prompt flow automatically when UI is available.

## Supported Arg Types

- `string`
- `number` with optional `integer`, `min`, and `max`
- `boolean` with `--flag`, `--flag true`, and `--no-flag`
- `enum` with typed string values

Common fields: `description`, `required`, `default`, `aliases`, and `placeholder`.

## Companion Commands

- `/typed-commands` lists typed commands registered in the current Pi session.

## Notes

Pi's native command API still receives a raw argument string. This package wraps `pi.registerCommand()`, parses and validates the raw args, generates completions, and opens Pi TUI prompts when needed.
