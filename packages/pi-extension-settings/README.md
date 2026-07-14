# Pi Extension Settings

Persistent, typed settings for [Pi](https://github.com/badlogic/pi-mono) extensions.

Define one TypeBox schema and this package uses it for defaults, runtime validation, `config.schema.json`, and generated documentation.

The runtime API consists of:

- `defineExtensionSettings()` for defining settings.
- `loadPiExtensionSettings()` for loading defaults, global settings, and trusted project overrides.
- `getPiGlobalSettingsPath()` and `getPiProjectSettingsPath()` for locating settings files.

## Recommended: use the template

For the easiest setup, use [pi-extension-template](https://github.com/zigai/pi-extension-template), which has extension settings built in.

If you do not want to use the template, or you want to add settings to an existing extension, follow the manual setup below.

## Manual setup

### Install

```sh
npm install @zigai/pi-extension-settings
```

### Define and load settings

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

export default settingsDefinition;
```

### Generate the schema and documentation

Add the settings definition and commands to `package.json`:

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

Then run:

```sh
npm run config:generate
npm run config:check
```

`generate` writes `config.schema.json` and adds or updates the generated configuration section in the README. `check` verifies that both artifacts are current without changing files, making it suitable for pre-commit and CI.

## Settings behavior

```text
TypeBox defaults → global settings → trusted project settings
```

Objects merge recursively; arrays and scalar values replace. Invalid settings are ignored with a diagnostic, existing settings are never overwritten, and project settings are ignored for untrusted projects.

```text
<getAgentDir()>/extension-settings/<id>.json
<cwd>/<CONFIG_DIR_NAME>/extension-settings/<id>.json
```

Keep secrets in environment variables or secure storage rather than settings JSON.

## Development

```sh
just setup
just coverage
```
