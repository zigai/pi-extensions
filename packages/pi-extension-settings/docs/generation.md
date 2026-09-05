# Generated artifacts and commands

The CLI turns each package's `piExtensionSettings` manifest into checked-in artifacts. It supports a standalone package and npm workspaces.

## Manifest

```json
{
  "piExtensionSettings": {
    "definition": "./src/settings-input.ts",
    "prevalidation": "./src/settings.prevalidated.ts"
  }
}
```

| Field           | Required | Default                   | Purpose                                                                             |
| --------------- | -------- | ------------------------- | ----------------------------------------------------------------------------------- |
| `definition`    | yes      | —                         | TypeScript module whose default export is a settings definition or definition input |
| `prevalidation` | no       | —                         | Generated runtime artifact path                                                     |
| `schema`        | no       | `config.schema.json`      | Generated JSON Schema path                                                          |
| `readme`        | no       | `README.md`               | README whose marked configuration section is generated                              |
| `globalPath`    | no       | Pi's standard global path | Display path used in generated README documentation                                 |

Every configured path must be relative and remain inside its package. The README must already exist. If the package uses a `files` allowlist, its published artifact must include the definition and prevalidation modules named by the manifest.

Definitions may include `exampleSettings` when structured or interacting options benefit from a realistic non-default example. Generation validates the example and includes it in the generated README section.

## Generate artifacts

```sh
pi-extension-settings generate
```

`generate` imports and validates each discovered definition, then updates the JSON Schema, optional prevalidation artifact, and marked README section. Invalid inputs fail before writes begin, and current files remain unchanged.

The command mutates checked-in files. Projects can run it explicitly or through their preferred authoring automation.

## Verify artifacts

```sh
pi-extension-settings check
```

`check` performs the same discovery and validation without modifying files. It fails for invalid inputs and missing or stale artifacts, making it suitable for pre-commit, CI, verification, and release gates.

For prevalidated definitions, `check` also compares codec function text and non-enumerable schema metadata. Runtime hydration checks the JSON-visible contract only: Pi and bundlers can rewrite equivalent codec functions. Run `generate` and `check` against the authoring source before packaging.

## Package scripts

Short package scripts keep automation independent of the installed CLI path:

```json
{
  "scripts": {
    "config:generate": "pi-extension-settings generate",
    "config:check": "pi-extension-settings check"
  }
}
```

These names are conventions, not requirements. Include `config:check` in the package's canonical verification command so stale generated files cannot be released.

## Roots and workspaces

Commands use the current directory by default. Pass `--root` for another package or npm workspace root:

```sh
pi-extension-settings check --root ./path/to/repository
```

At a workspace root, the CLI reads the root package and packages matched by its npm `workspaces` patterns. Only packages with a `piExtensionSettings` manifest participate.
