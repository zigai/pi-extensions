# Pi Typed Commands

This Pi extension adds typed named slash-command and Agent Skill arguments with live hints and TUI argument forms.

## Install

```sh
pi install git:github.com/zigai/pi-typed-commands
```

For private/local startup without GitHub auth, reference the local clone from `~/.pi/agent/settings.json`:

```json
{
  "packages": ["/home/zigai/Projects/pi-typed-commands"]
}
```

## What It Adds

`pi-typed-commands` is both:

- a small library for extension authors to register typed named args;
- a companion Pi extension that shows a one-line helper while typing typed commands; and
- a typed argument layer for Agent Skills that opt in with top-level `arguments` frontmatter.

The companion extension watches the editor and shows a compact hint for registered typed commands:

```text
usage: /branch action:create | delete | rename name [--base=branch] [--checkout]
```

## Usage In Extensions

```ts
import { registerTypedCommand } from "pi-typed-commands";
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

Manual argument form flow:

```text
/deploy<Tab>
/deploy --env staging<Tab>
```

When the editor contains a completed typed command, pressing Tab opens the dense form and pre-fills it from any arguments already present.

Detailed help:

```text
/deploy --help
/deploy -h
```

If a required argument is missing or an argument is invalid, the command opens the argument form automatically when UI is available.

## Supported Arg Types

- `string` with optional `minLength`, `maxLength`, and `pattern`
- `number` with optional `integer`, `min`, and `max`
- `boolean` with `--flag`, `--flag true`, and `--no-flag`
- `enum` with typed string values
- `multi-enum` with comma-separated or repeated flags, such as `--tag api,web --tag worker`, and optional `minItems` / `maxItems`

Common fields: `description`, `required`, `default`, `placeholder`, `positional`, and `ui`. Set `positional: true` or a numeric order such as `positional: 0` to parse a CLI-style positional arg before named `--flags`.

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

Run `/typed-commands-demo<Tab>` to open a showcase form containing every supported widget.

## Typed Agent Skills

Skills can opt in by adding typed argument metadata to `SKILL.md` frontmatter under top-level `arguments`:

```yaml
---
name: fix-ruff-errors
description: Fix Ruff lint errors in Python projects.
form_title: Fix Ruff errors
arguments:
  path:
    type: string
    positional: 0
    default: "."
    description: File or directory to check
  fix:
    type: boolean
    default: true
    description: Apply safe fixes
  rules:
    type: multi_enum
    values: ["E", "F", "I", "UP"]
    min_items: 1
    description: Ruff rule families
---

Run Ruff against `{args.path}`.
Safe fixes enabled: `{args.fix}`.
Rules: `{args.rules}`.
```

Invoke typed skills through Pi's normal skill command syntax:

```text
/skill:fix-ruff-errors src --no-fix --rules E,F
```

The extension discovers skill commands from Pi, reads each `SKILL.md`, and gives typed skills the same helper text, flag completions, enum completions, required-argument validation, and Tab-to-form flow as typed slash commands.

Skill metadata uses the same serializable argument fields as commands. In YAML, use `multi_enum`, `min_length`, `max_length`, `min_items`, and `max_items`; they are normalized to the internal `multi-enum`, `minLength`, `maxLength`, `minItems`, and `maxItems` fields. Nested metadata objects are flattened into nested argument paths, so `config.path` can be referenced as `{args.config.path}` and completed as `--config-path`. Argument path segments may use letters, numbers, dots, underscores, and hyphens, but prototype-reserved segments such as `__proto__`, `constructor`, and `prototype` are rejected. A JSON Schema for the top-level `arguments` field is available at `schemas/skill-arguments.schema.json`.

Required/default behavior is the same as slash commands: defaults are applied before required checks, so an argument with `default` is never missing at runtime. Without a default, set `required: true` to require a value; omit it or set `required: false` to make the argument optional. Defaults are validated against type-specific constraints. Invalid skill argument schemas produce a descriptive error when the skill is invoked.

Skill bodies can interpolate typed values with `{args.name}` placeholders. Nested placeholders such as `{args.config.path}` are supported. Arrays render as comma-separated text in placeholders. Missing optional values render as an empty string. No filter or pipe syntax is supported.

If a typed skill does not contain any `{args.*}` placeholders, the extension appends an `ARGUMENTS` YAML block to the rendered skill prompt. Any extra freeform text that was not consumed by typed positional args is preserved in an `ADDITIONAL_INPUT` block.

## Disabling Typed-Args Features

There are two levels of opt-out:

1. Disable all typed-args behavior globally in Pi settings:

```json
{
  "piTypedCommands": {
    "enabled": false
  }
}
```

This disables command arg completions, live hints, typed parsing, and auto-forms for all commands using this package. If a command configured `fallbackHandler`, it receives Pi's raw argument string instead.

To keep typed parsing/forms but hide only the live one-line helper, use:

```json
{
  "piTypedCommands": {
    "uxEnabled": false
  }
}
```

The inline helper hides primitive types by default for compactness. To show them, use:

```json
{
  "piTypedCommands": {
    "uxShowTypes": true
  }
}
```

For example, `prompt` becomes `prompt:string`, and `[count=1]` becomes `[count:int=1]`.

Environment overrides are also supported: `PI_TYPED_COMMANDS=0` disables everything, `PI_TYPED_COMMANDS_UX=0` disables only the helper, and `PI_TYPED_COMMANDS_UX_SHOW_TYPES=1` shows inline helper types.

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

Pi's native command API still receives a raw argument string. This package wraps `pi.registerCommand()`, parses and validates the raw args, generates completions, and opens Pi TUI argument forms when needed.
