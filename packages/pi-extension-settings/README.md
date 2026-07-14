# Pi Extension Settings

TypeBox-first runtime and artifact tooling for persistent Pi extension settings.

The package keeps one settings definition authoritative and derives all other representations from it:

- typed runtime settings;
- deeply partial global and project input schemas;
- `config.schema.json`;
- the README option table and complete default JSON;
- the global user config scaffold;
- the local editor schema installed beside global extension settings.

## Install

This package is private. Standalone extension repositories should vendor a versioned tarball so clean CI checkouts and downstream installs do not depend on a sibling clone:

```sh
mkdir -p vendor
tarball=$(npm pack ../pi-extension-settings --pack-destination vendor)
npm install "./vendor/$tarball"
```

Keep the resulting `file:vendor/...tgz` runtime dependency and tarball checked in, and add `@zigai/pi-extension-settings` to `bundleDependencies` so the published extension remains independently installable. The Pi extension template performs these steps automatically when its settings scaffold is selected. A private registry can replace the vendor tarball later without changing the library API.

List `typebox` and `@earendil-works/pi-coding-agent` as Pi-provided peer dependencies and as development dependencies for local checks.

## Define settings

Keep each extension's definition and runtime settings boundary together in `src/settings.ts`. The module may export loading helpers, but importing it must not perform filesystem or Pi lifecycle work.

```ts
import { defineExtensionSettings } from "@zigai/pi-extension-settings";
import { Type } from "typebox";

export const exampleSettingsDefinition = defineExtensionSettings({
  id: "pi-example",
  title: "Pi Example",
  description: "Settings for the Pi example extension.",
  schemaId: "https://raw.githubusercontent.com/zigai/pi-example/master/config.schema.json",
  schema: Type.Object(
    {
      enabled: Type.Boolean({
        default: true,
        description: "Enable the extension.",
      }),
      appearance: Type.Object(
        {
          color: Type.String({
            default: "blue",
            description: "Accent color.",
          }),
        },
        { default: {}, additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
});

export default exampleSettingsDefinition;
```

Definition requirements are checked immediately:

- `id` is stable and filename-safe;
- every object schema rejects unknown properties;
- every user-facing leaf setting has a description;
- required settings have valid defaults;
- the complete defaults are JSON data and decode successfully;
- `schemaId`, when supplied, is an absolute URI.

JSON Schema `default` is only an annotation. This package explicitly applies TypeBox defaults once, then validates and decodes the resolved configuration.

## Configure generated artifacts

Add a package-level manifest:

```json
{
  "piExtensionSettings": {
    "definition": "./src/settings.ts",
    "schema": "./config.schema.json",
    "readme": "./README.md"
  },
  "scripts": {
    "config:generate": "pi-extension-settings generate",
    "config:check": "pi-extension-settings check"
  }
}
```

`schema` defaults to `./config.schema.json` and `readme` defaults to `./README.md`. Paths must be relative and remain inside the package.

Place exactly one generated region in the README:

```md
<!-- pi-extension-settings:start -->
<!-- generated configuration documentation -->
<!-- pi-extension-settings:end -->
```

Then run:

```sh
npm run config:generate
npm run config:check
```

`generate` updates only `config.schema.json` and the marked README region. `check` performs no writes and fails when either artifact is stale, making it suitable for pre-commit and CI.

For npm workspaces, run the command at the workspace root. Configured root and workspace packages are discovered from their individual `package.json` manifests.

Include `config.schema.json` in each published extension package's `files` allowlist.

## Load settings at runtime

Use the Pi adapter from the `./pi` export. Expose one package-facing `load<ExtensionName>Settings` function from `src/settings.ts`; it owns the shared adapter call so ordinary extension code does not depend on definition and storage mechanics:

```ts
import type { PiSettingsContext } from "@zigai/pi-extension-settings/pi";
import { loadPiExtensionSettings } from "@zigai/pi-extension-settings/pi";

export function loadExampleSettings(ctx: PiSettingsContext) {
  return loadPiExtensionSettings(exampleSettingsDefinition, ctx, {
    bundledSchema: {
      kind: "url",
      url: new URL("../config.schema.json", import.meta.url),
    },
  });
}
```

The extension entrypoint calls that package-level loader:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadExampleSettings } from "./settings.ts";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const loaded = await loadExampleSettings(ctx);
    for (const diagnostic of loaded.diagnostics) {
      ctx.ui.notify(diagnostic.message, diagnostic.severity);
    }
    useSettings(loaded.settings);
  });
}
```

The lower-level `loadExtensionSettings` API accepts explicit directories and trust state for other hosts and filesystem-level tests. Synchronous call paths can use `loadPiExtensionSettingsSync` or `loadExtensionSettingsSync` with the same options and result shape. The result also exposes validated `globalSettingsLayer` and `projectSettingsLayer` values for extensions that apply additional domain-specific merge semantics.

## Storage layout

Global settings are centralized under Pi's agent directory:

```text
<getAgentDir()>/extension-settings/
├── pi-example.json
└── schemas/
    └── pi-example.schema.json
```

The scaffolded global file references its local editor schema:

```json
{
  "$schema": "./schemas/pi-example.schema.json",
  "enabled": true,
  "appearance": {
    "color": "blue"
  }
}
```

Project overrides use Pi's configured project directory name:

```text
<cwd>/<CONFIG_DIR_NAME>/extension-settings/pi-example.json
```

Project files are read only when `ctx.isProjectTrusted()` is true. They are never created automatically. A committed project override can use the definition's stable HTTPS `schemaId` in its `$schema` field without requiring the extension to write generated files into the project.

The Pi adapter non-destructively migrates the former per-extension layout (`<getAgentDir()>/<id>/config.json` and `<cwd>/<CONFIG_DIR_NAME>/<id>/config.json`) when the corresponding centralized file is absent. Pass `legacySettingsIds` for earlier extension names and `legacyConfigPaths` for historical filenames or nonstandard locations. Migration creates the centralized file exactly once and updates a valid JSON object's `$schema` metadata for its new location. Malformed or non-object legacy content is copied unchanged, and an existing centralized file is never overwritten.

## Runtime guarantees

Settings resolve in this order:

```text
TypeBox defaults → global settings → trusted project settings
```

Each persisted layer is decoded as a deeply partial object. Objects merge recursively; arrays and scalar values replace. Defaults are applied only once, so a partial project override cannot reset global choices back to defaults.

The loader also guarantees:

- `JSON.parse` output remains `unknown` until TypeBox validation and decoding;
- unknown keys are rejected;
- malformed or invalid layers are reported and ignored;
- diagnostics contain paths and schema issues, not raw setting values;
- existing and malformed user config is never replaced or repaired;
- legacy per-extension config is copied only when the centralized target is absent;
- global config uses exclusive creation and is scaffolded only when missing;
- the bundled checked-in schema must exactly match the TypeBox-derived schema;
- the global schema is created or refreshed with an atomic replacement;
- schema refresh is independent of user-config parsing;
- project config is never scaffolded or modified.

Secrets should remain in environment variables or purpose-built secure storage rather than ordinary JSON settings.

## Development

```sh
npm install
just check
just coverage
```

`npm run check` runs formatting, lint, strict TypeScript checks, all behavior tests, and enforced coverage thresholds.
