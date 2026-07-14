# Pi Extension Settings

Persistent, typed settings for [Pi](https://github.com/badlogic/pi-mono) extensions. Define one TypeBox schema and this package derives defaults, runtime validation, `config.schema.json`, and the generated configuration section of your README.

Its public API is intentionally small:

- `defineExtensionSettings()` defines settings and validates the definition.
- `loadPiExtensionSettings()` loads defaults, global settings, and trusted project overrides.
- `getPiGlobalSettingsPath()` and `getPiProjectSettingsPath()` expose the corresponding file paths.
- `pi-extension-settings generate` and `pi-extension-settings check` maintain generated artifacts.

## Start with the template

Use [pi-extension-template](https://github.com/zigai/pi-extension-template) for a new extension. Select its extension-settings option: it creates the definition, loader, artifact configuration, checks, Git hooks, and package setup for you.

The rest of this README is for adding settings to an existing extension.

## Install

```sh
npm install @zigai/pi-extension-settings typebox
npm install --save-dev @earendil-works/pi-coding-agent
```

Add `@zigai/pi-extension-settings` to `bundleDependencies` if your extension package must remain independently installable.

## Define and load

Keep the definition and its package-facing loader in `src/settings.ts`:

```ts
import { defineExtensionSettings } from "@zigai/pi-extension-settings";
import { loadPiExtensionSettings, type PiSettingsContext } from "@zigai/pi-extension-settings/pi";
import { Type } from "typebox";

export const settingsDefinition = defineExtensionSettings({
  id: "pi-example",
  title: "Pi Example",
  description: "Settings for Pi Example.",
  schemaId: "https://raw.githubusercontent.com/zigai/pi-example/main/config.schema.json",
  schema: Type.Object(
    {
      enabled: Type.Boolean({ default: true, description: "Enable the extension." }),
    },
    { additionalProperties: false },
  ),
});

export function loadExampleSettings(ctx: PiSettingsContext) {
  return loadPiExtensionSettings(settingsDefinition, ctx, {
    bundledSchema: { kind: "url", url: new URL("../config.schema.json", import.meta.url) },
  });
}
```

Use the loader from your extension entrypoint and surface any diagnostics:

```ts
const loaded = loadExampleSettings(ctx);
for (const diagnostic of loaded.diagnostics) {
  ctx.ui.notify(diagnostic.message, diagnostic.severity);
}

if (!loaded.settings.enabled) return;
```

## Generate documentation and schema

Add this to `package.json`:

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

Add these markers once to your README:

```md
<!-- pi-extension-settings:start -->
<!-- pi-extension-settings:end -->
```

Generate and check the artifacts:

```sh
npm run config:generate
npm run config:check
```

`generate` updates `config.schema.json` and the marked README section. `check` makes no changes, so use it in pre-commit and CI.

## Behavior

Settings resolve in this order:

```text
TypeBox defaults → global settings → trusted project settings
```

Objects merge recursively; arrays and scalar values replace. Invalid or incomplete JSON is ignored with a diagnostic, so typed runtime settings always satisfy the TypeBox schema. Existing settings are never overwritten. Project settings are never created and are ignored for untrusted projects.

```text
<getAgentDir()>/extension-settings/<id>.json
<cwd>/<CONFIG_DIR_NAME>/extension-settings/<id>.json
```

Keep secrets in environment variables or secure storage, not settings JSON.

## Development

```sh
just setup
just coverage
```
