# Pi Extension Settings

TypeBox-first runtime and artifact tooling for persistent Pi extension settings. One definition drives typed settings, defaults, JSON Schema, README documentation, and runtime loading.

## Install

This package is private. Standalone extensions should vendor it so CI and downstream installs do not require a sibling clone:

```sh
mkdir -p vendor
tarball=$(npm pack ../pi-extension-settings --pack-destination vendor)
npm install "./vendor/$tarball"
```

Check in the tarball and `file:vendor/...tgz` dependency, and add `@zigai/pi-extension-settings` to `bundleDependencies`. The Pi extension template handles this automatically when its settings scaffold is selected.

Keep `typebox` and `@earendil-works/pi-coding-agent` in peer dependencies and local development dependencies.

## Define and load settings

Keep the definition and package-facing loader together in `src/settings.ts`. Importing this module must not perform filesystem or Pi lifecycle work.

```ts
import { defineExtensionSettings } from "@zigai/pi-extension-settings";
import {
  loadPiExtensionSettingsSync,
  type PiSettingsContext,
} from "@zigai/pi-extension-settings/pi";
import { Type } from "typebox";

export const exampleSettingsDefinition = defineExtensionSettings({
  id: "pi-example",
  title: "Pi Example",
  description: "Settings for Pi Example.",
  schemaId: "https://raw.githubusercontent.com/zigai/pi-example/master/config.schema.json",
  schema: Type.Object(
    {
      enabled: Type.Boolean({
        default: true,
        description: "Enable the extension.",
      }),
    },
    { additionalProperties: false },
  ),
});

export function loadExampleSettings(ctx: PiSettingsContext) {
  return loadPiExtensionSettingsSync(exampleSettingsDefinition, ctx, {
    bundledSchema: {
      kind: "url",
      url: new URL("../config.schema.json", import.meta.url),
    },
  });
}

export default exampleSettingsDefinition;
```

Definitions require filename-safe IDs, closed object schemas, descriptions for user-facing leaves, and valid defaults.

## Generate artifacts

Register the definition in `package.json`:

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

Add one generated README region:

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

`generate` updates `config.schema.json` and the marked README region. `check` is non-mutating and suitable for pre-commit and CI. Workspace commands discover configured root and workspace packages automatically.

## Runtime behavior

Settings resolve as:

```text
TypeBox defaults → global settings → trusted project settings
```

Objects merge recursively; arrays and scalar values replace. Persisted JSON remains `unknown` until TypeBox validation and decoding.

Storage paths:

```text
<getAgentDir()>/extension-settings/<id>.json
<getAgentDir()>/extension-settings/schemas/<id>.schema.json
<cwd>/<CONFIG_DIR_NAME>/extension-settings/<id>.json
```

The loader:

- scaffolds global settings only when missing;
- never creates project settings or reads them for untrusted projects;
- never overwrites malformed or existing user settings;
- refreshes missing or stale installed schemas atomically;
- reports safe diagnostics without raw setting values;
- migrates legacy per-extension paths only when the centralized target is absent.

Use `legacySettingsIds` for former extension IDs and `legacyConfigPaths` for nonstandard historical locations. The original legacy file remains untouched.

Async callers can use `loadPiExtensionSettings`; non-Pi hosts and filesystem tests can use `loadExtensionSettings` or `loadExtensionSettingsSync` with explicit paths and trust state.

Keep secrets in environment variables or purpose-built secure storage rather than ordinary settings JSON.

## Development

```sh
just setup
just coverage
```
