# Pi Typed Commands

Typed arguments for Pi slash commands and Agent Skills.

Register an argument schema once and get parsing, defaults, validation, completions, `--help`, live usage hints, and Tab-opened TUI forms.

## Install

```sh
pi install git:github.com/zigai/pi-typed-commands
```

For local development, add the clone to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["/home/zigai/Projects/pi-typed-commands"]
}
```

## Quick Start

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTypedCommand } from "pi-typed-commands";

export default function (pi: ExtensionAPI): void {
  registerTypedCommand(pi, "deploy", {
    description: "Deploy a ref",
    args: {
      env: {
        type: "enum",
        values: ["dev", "staging", "prod"] as const,
        positional: 0,
        required: true,
        description: "Target environment",
      },
      ref: {
        type: "string",
        default: "main",
        description: "Git ref",
      },
      dryRun: {
        type: "boolean",
        description: "Preview only",
      },
    },
    handler: async ({ env, ref, dryRun }, ctx) => {
      ctx.ui.notify(`Deploy ${ref} to ${env}; dryRun=${String(dryRun)}`);
    },
  });
}
```

Use it like a normal slash command:

```text
/deploy staging --ref feature/login --dry-run
/deploy<Tab>       # open the argument form
/deploy --help     # show generated help
```

## Docs

### Argument Types

| Type | Notes |
| --- | --- |
| `string` | Optional `minLength`, `maxLength`, `pattern` |
| `number` | Optional `integer`, `min`, `max` |
| `boolean` | Supports `--flag`, `--flag true`, and `--no-flag` |
| `enum` | One value from `values`; use a single-value enum for fixed literals |
| `multi-enum` | Comma-separated or repeated flags, e.g. `--tag api,web --tag worker` |

Common fields: `description`, `required`, `default`, `placeholder`, `positional`, and `ui`.

Set `positional: true` or `positional: 0` to consume positional values before named flags.

### Forms

Typing a completed command and pressing Tab opens a TUI form. Missing required args or invalid values open the form automatically when UI is available.

Customize forms with:

- `formTitle`
- `formSymbols`
- per-argument `ui` metadata

Supported widgets: `text`, `textarea`, `number`, `toggle`, `select`, `radio`, `multiselect`, `path`, `command`, `readonly`, `computed`, `confirm`, and `custom`.

### Agent Skills

Skills can opt in with top-level `arguments` frontmatter in `SKILL.md`:

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
    description: Ruff rule families
---

Run Ruff against `{args.path}`.
Safe fixes enabled: `{args.fix}`.
Rules: `{args.rules}`.
```

Invoke the skill normally:

```text
/skill:fix-ruff-errors src --no-fix --rules E,F
```

Skill YAML uses serializable field names such as `multi_enum`, `min_length`, `max_length`, `min_items`, and `max_items`. A JSON Schema is available at `schemas/skill-arguments.schema.json`.

### Configuration

Disable typed args globally:

```json
{
  "piTypedCommands": {
    "enabled": false
  }
}
```

Hide only the live helper:

```json
{
  "piTypedCommands": {
    "uxEnabled": false
  }
}
```

Show primitive types in the helper:

```json
{
  "piTypedCommands": {
    "uxShowTypes": true
  }
}
```

Environment overrides are also supported:

- `PI_TYPED_COMMANDS=0`
- `PI_TYPED_COMMANDS_UX=0`
- `PI_TYPED_COMMANDS_UX_SHOW_TYPES=1`

Per command, use `typedArgsEnabled`, `fallbackHandler`, or `shouldUseTypedArgs` when migrating legacy raw-argument commands.

## Notes

Pi still passes slash-command input as a raw string. This package wraps `pi.registerCommand()`, parses that string, validates it, and then calls your typed handler.
