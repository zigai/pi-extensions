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
    typedArgsEnabled: () => process.env.MY_EXTENSION_TYPED_ARGS !== "0",
    fallbackHandler: async (rawArgs, ctx) => {
      ctx.ui.notify(`Typed args disabled; received raw args: ${rawArgs}`);
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

## Disabling Typed-Args Features

There are two levels of opt-out:

1. Disable all typed-args behavior globally in Pi settings:

```json
{
  "piCommandArgs": {
    "enabled": false
  }
}
```

This disables command arg completions, live hints, typed parsing, and auto-wizards for all commands using this package. If a command configured `fallbackHandler`, it receives Pi's raw argument string instead.

To keep typed parsing/wizards but hide only the live one-line helper, use:

```json
{
  "piCommandArgs": {
    "uxEnabled": false
  }
}
```

Environment overrides are also supported: `PI_COMMAND_ARGS=0` disables everything and `PI_COMMAND_ARGS_UX=0` disables only the helper.

2. Let a consuming extension disable typed args per command with `typedArgsEnabled` and `fallbackHandler`:

```ts
registerTypedCommand(pi, "deploy", {
  description: "Deploy a ref",
  args: {
    /* ... */
  },
  typedArgsEnabled: () => userConfig.typedArgs !== false,
  fallbackHandler: async (rawArgs, ctx) => runLegacyDeploy(rawArgs, ctx),
  handler: async (typedArgs, ctx) => runTypedDeploy(typedArgs, ctx),
});
```

When `typedArgsEnabled` returns `false`, command arg completions, live hints, typed parsing, and auto-wizards are skipped for that command. The `fallbackHandler` receives Pi's raw argument string.

For legacy-compatible migrations, a command can also set `shouldUseTypedArgs(rawArgs, ctx)`. When it returns `false`, the typed parser is skipped for that invocation and `fallbackHandler` receives the raw argument string.

## Notes

Pi's native command API still receives a raw argument string. This package wraps `pi.registerCommand()`, parses and validates the raw args, generates completions, and opens Pi TUI prompts when needed.
