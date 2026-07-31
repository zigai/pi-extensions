# Typed Agent Skills

Pi Typed Args can read typed argument metadata from Agent Skill `SKILL.md` frontmatter. This lets a skill use the same parser, validation, completions, and form model as extension commands.

## Frontmatter shape

Use a top-level `arguments` object:

```yaml
---
name: fix-ruff-errors
description: Fix Ruff lint errors in Python projects.
form_title: Fix Ruff errors
metadata:
  ghostText: Choose a path and Ruff options
arguments:
  path:
    type: string
    position: 0
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

`metadata.ghostText` is optional. It renders static, dimmed text on the same editor line as the exact `/skill:name` invocation, remains visible through one trailing space, and disappears when the user types a second space or starts an argument. It is visual only and is never included in the skill input. `SKILL.md` is declarative, so dynamic resolver functions are available only to TypeScript command definitions.

## YAML field names

Skill YAML uses serializable names for fields that are camelCase in TypeScript:

| YAML                  | TypeScript           |
| --------------------- | -------------------- |
| `multi_enum`          | `multi-enum`         |
| `min_length`          | `minLength`          |
| `max_length`          | `maxLength`          |
| `min_items`           | `minItems`           |
| `max_items`           | `maxItems`           |
| `option_descriptions` | `optionDescriptions` |
| `string_list`         | `string-list`        |
| `key_value`           | `key-value`          |
| `copy_from`           | `ui.copyFrom`        |
| `visible_when`        | `ui.visibleWhen`     |
| `enabled_when`        | `ui.enabledWhen`     |
| `required_when`       | `ui.requiredWhen`    |

Serializable skill arguments also support semantic string `format`, `sensitive`, numeric `step`/`unit`, `examples`, `string_list`, `key_value`, and the expanded built-in widget set. Skill conditions are declarative booleans; TypeScript commands may additionally use value-dependent functions.

## Placeholders

Skill bodies can reference typed values with `{args.name}` placeholders. Nested paths are supported for dotted argument names.

```md
Use `{args.path}` and rules `{args.rules}`.
```

Unknown placeholders are reported as diagnostics when the skill metadata is loaded.

## Rendering safety

Typed skill values are rendered as JSON data literals. Values that look like Markdown fences, XML tags, or prompt structure are treated as data instead of instructions.

When a skill body does not reference all provided values, the renderer appends an `ARGUMENTS_JSON` block. Additional freeform user input is appended as `ADDITIONAL_INPUT_JSON`.

## Diagnostics

Skill normalization returns structured diagnostics:

```ts
import { readTypedSkillMetadataResult } from "pi-typed-args/skills";

const result = readTypedSkillMetadataResult("/path/to/SKILL.md");

if (result.status === "invalid") {
  result.diagnostics.diagnostics;
}

if (result.status === "ok") {
  result.metadata;
}

if (result.status === "absent") {
  // The skill does not declare typed arguments.
}
```

Diagnostics include a code, message, path, and severity. Invalid YAML frontmatter, unreadable files, unknown `{args.*}` placeholders, invalid argument schemas, and unsupported typed argument fields return `invalid`; skills without typed arguments return `absent`. YAML source text and dependency error messages are not included in diagnostics.

## JSON Schema

The JSON Schema for skill arguments is exported as a package subpath and stored in the repository:

```ts
import schema from "pi-typed-args/schema";
```

Repository path:

```text
schemas/skill-arguments.schema.json
```

The schema mirrors the compiler rules for serializable skill definitions, including required/default exclusivity, enum uniqueness, valid widgets, and positional constraints.
