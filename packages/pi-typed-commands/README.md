# Pi Command Args

This Pi extension adds typed named slash-command arguments with live hints and TUI prompts.

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
usage: /branch action:create | delete | rename name [--base=branch] [--checkout]
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
        positional: 0,
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
/deploy staging --ref main --dry-run
```

Manual TUI prompt flow:

```text
/deploy<Tab>
/deploy --env staging<Tab>
/deploy ?
```

When the editor contains a completed typed command, pressing Tab opens the dense form and pre-fills it from any arguments already present.

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
- `multi-enum` with comma-separated or repeated flags, such as `--tag api,web --tag worker`

Common fields: `description`, `required`, `default`, `aliases`, `placeholder`, `positional`, and `ui`. Set `positional: true` or a numeric order such as `positional: 0` to parse a CLI-style positional arg before named `--flags`.

## Form Widgets

Commands can customize the dense TUI form with `formTitle`, `formSymbols`, and per-argument `ui` metadata:

```ts
registerTypedCommand(pi, "branch", {
  description: "Fork this session",
  formTitle: "Branch session",
  formSymbols: {
    selectedCheckbox: "■",
    unselectedCheckbox: "□",
    selectedRadio: "●",
    unselectedRadio: "○",
  },
  args: {
    prompt: {
      type: "string",
      ui: { widget: "textarea", rows: 5 },
    },
  },
  handler: async (args) => {},
});
```

Supported widget names are `text`, `textarea`, `number`, `toggle`, `select`, `radio`, `multiselect`, `path`, `command`, `readonly`, `computed`, `confirm`, and `custom`. They are implemented with Pi's native TUI components; no extra runtime dependency is required. The default form symbols are `■`/`□` for selected/unselected checkboxes and `●`/`○` for selected/unselected radio options.

For highly tailored forms, attach a custom widget renderer/input handler:

```ts
count: {
  type: "number",
  default: 1,
  ui: {
    widget: "custom",
    custom: {
      renderValue: ({ value, selected, theme }) => {
        const text = `forks ${String(value ?? 1)}`;
        return selected ? theme.fg("accent", text) : text;
      },
      handleInput: ({ data, value, setValue }) => {
        if (data === "+") {
          setValue(Number(value ?? 1) + 1);
          return true;
        }
        if (data === "-") {
          setValue(Math.max(1, Number(value ?? 1) - 1));
          return true;
        }
      },
    },
  },
}
```

Run `/command-args-demo ?` to open a showcase form containing every supported widget.

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

This disables command arg completions, live hints, typed parsing, and auto-forms for all commands using this package. If a command configured `fallbackHandler`, it receives Pi's raw argument string instead.

To keep typed parsing/forms but hide only the live one-line helper, use:

```json
{
  "piCommandArgs": {
    "uxEnabled": false
  }
}
```

The inline helper hides primitive types by default for compactness. To show them, use:

```json
{
  "piCommandArgs": {
    "uxShowTypes": true
  }
}
```

For example, `prompt` becomes `prompt:string`, and `[count=1]` becomes `[count:int=1]`.

Environment overrides are also supported: `PI_COMMAND_ARGS=0` disables everything, `PI_COMMAND_ARGS_UX=0` disables only the helper, and `PI_COMMAND_ARGS_UX_SHOW_TYPES=1` shows inline helper types.

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

When `typedArgsEnabled` returns `false`, command arg completions, live hints, typed parsing, and auto-forms are skipped for that command. The `fallbackHandler` receives Pi's raw argument string.

For legacy-compatible migrations, a command can also set `shouldUseTypedArgs(rawArgs, ctx)`. When it returns `false`, the typed parser is skipped for that invocation and `fallbackHandler` receives the raw argument string.

## Notes

Pi's native command API still receives a raw argument string. This package wraps `pi.registerCommand()`, parses and validates the raw args, generates completions, and opens Pi TUI prompts when needed.
