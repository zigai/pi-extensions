# Typed Agent Skills

Pi Typed Args can read typed argument metadata from Agent Skill `SKILL.md` frontmatter. This lets a skill use the same parser, validation, completions, and form model as extension commands.

## Frontmatter shape

Use a top-level `arguments` object:

```yaml
---
name: fix-ruff-errors
description: Fix Ruff lint errors in Python projects.
form_title: Fix Ruff errors
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

## YAML field names

Skill YAML uses serializable names for fields that are camelCase in TypeScript:

| YAML         | TypeScript   |
| ------------ | ------------ |
| `multi_enum` | `multi-enum` |
| `min_length` | `minLength`  |
| `max_length` | `maxLength`  |
| `min_items`  | `minItems`   |
| `max_items`  | `maxItems`   |

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
const result = readTypedSkillMetadataResult("/path/to/SKILL.md");

if (result.status === "invalid") {
  result.diagnostics.diagnostics;
}

if (result.status === "ok") {
  result.metadata;
}
```

Diagnostics include a code, message, path, and severity. Invalid YAML frontmatter, unknown `{args.*}` placeholders, invalid argument schemas, and unsupported typed argument fields are reported as diagnostics instead of throwing during metadata loading.

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
