# Pi Extension Settings

Persistent, typed settings for [Pi](https://github.com/badlogic/pi-mono) extensions. Define one TypeBox schema and use it for defaults, runtime validation, `config.schema.json`, and generated documentation.

## Install

We recommend starting new extensions with [pi-extension-template](https://github.com/zigai/pi-extension-template) because it includes settings support. To add settings to an existing extension, install the package:

```sh
npm install @zigai/pi-extension-settings
```

## Define settings

Keep schema authoring in `src/settings-input.ts`. The generator imports this module, so it must not import the generated artifact or Pi runtime.

```ts
import type { ExtensionSettingsDefinitionInput } from "@zigai/pi-extension-settings";
import { Type } from "typebox";

export const settingsSchema = Type.Object(
  {
    enabled: Type.Boolean({
      default: true,
      description: "Enable the extension's behavior.",
      "x-control": "switch",
    }),
    excludedTools: Type.Array(Type.String(), {
      default: [],
      description: "Tool names the extension should ignore.",
    }),
  },
  { additionalProperties: false },
);

const settingsInput = {
  id: "pi-example",
  title: "Pi Example",
  description: "Settings for Pi Example.",
  schemaId: "https://raw.githubusercontent.com/zigai/pi-example/main/config.schema.json",
  schema: settingsSchema,
  exampleSettings: {
    excludedTools: ["bash", "write"],
  },
} as const satisfies ExtensionSettingsDefinitionInput<typeof settingsSchema>;

export default settingsInput;
```

`exampleSettings` is optional. Use it only when complex settings need a realistic non-default example in the generated documentation.

## Generate artifacts

Add the definition, prevalidation artifact, and commands to `package.json`:

```json
{
  "piExtensionSettings": {
    "definition": "./src/settings-input.ts",
    "prevalidation": "./src/settings.prevalidated.ts"
  },
  "scripts": {
    "config:generate": "pi-extension-settings generate",
    "config:check": "pi-extension-settings check"
  }
}
```

The schema and README paths default to `config.schema.json` and `README.md`; set `schema` or `readme` in the manifest only to override them.

```sh
npm run config:generate
npm run config:check
```

`generate` writes the schema and prevalidation artifact and updates the generated README configuration section. Commit all three outputs. `check` verifies them without modifying files, making it suitable for pre-commit and CI. Both commands support standalone packages and npm workspaces.

## Load settings in Pi

The `/pi` and `/runtime` imports are for extension code loaded by Pi. In Node.js scripts and other authoring tools, import from the package root instead.

```ts
import { loadPiExtensionSettings, type PiSettingsContext } from "@zigai/pi-extension-settings/pi";
import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";
import type { StaticDecode } from "typebox";

import artifact from "./settings.prevalidated.ts";
import settingsInput, { settingsSchema } from "./settings-input.ts";

export type ExtensionSettings = StaticDecode<typeof settingsSchema>;

export const settingsDefinition = definePrevalidatedExtensionSettings(settingsInput, artifact);

export function loadExampleSettings(ctx: PiSettingsContext) {
  return loadPiExtensionSettings(settingsDefinition, ctx, {
    bundledSchema: { kind: "url", url: new URL("../config.schema.json", import.meta.url) },
  });
}

export default settingsDefinition;
```

Settings are resolved from schema defaults, global settings, and then trusted project settings. Objects merge recursively; arrays and scalar values replace earlier values. Invalid layers are ignored and reported in `diagnostics`.

Loading installs the generated editor schema and creates the global settings file when missing. It never overwrites an existing settings file or creates a project settings file. Use `getPiGlobalSettingsPath()` and `getPiProjectSettingsPath()` when you need the resolved paths.

`StaticDecode` represents the resolved value after TypeBox codecs run; use it instead of `Static` for runtime settings types.

## Update settings

Use `updatePiExtensionSettings()` to update the latest global or project settings layer with locking, validation, and atomic writes. Load settings first to install and verify the schema.

```ts
import { updatePiExtensionSettings } from "@zigai/pi-extension-settings/pi";

const result = await updatePiExtensionSettings(settingsDefinition, ctx, {
  scope: "global",
  update: (current) => ({ ...current, enabled: false }),
});

if (result.status !== "updated" && result.status !== "unchanged") {
  ctx.ui.notify(result.message, "error");
}
```

The synchronous callback receives the latest encoded layer and runs once while the settings file is locked. Invalid files and updates remain untouched, and project updates require a trusted project.

For snapshot-based editors, pass the loaded `globalRevision` or `projectRevision` as `expectedRevision`; a stale revision returns `conflict`. Omit it to update the latest valid layer.

## Optional UI controls

The optional `x-control` TypeBox annotation tells compatible settings editors how to present a property. It does not affect validation, defaults, or loading. [Pi Settings UI](https://github.com/zigai/pi-settings-ui) supports:

| `x-control`   | Compatible schema           | Presentation                                                            |
| ------------- | --------------------------- | ----------------------------------------------------------------------- |
| `text`        | string                      | Single-line input                                                       |
| `textarea`    | string                      | Multiline editor                                                        |
| `switch`      | boolean                     | Toggle                                                                  |
| `segmented`   | primitive choices           | Compact Left/Right choice                                               |
| `select`      | primitive choices           | Searchable picker                                                       |
| `slider`      | number or integer           | Range control using schema bounds and `multipleOf`                      |
| `numeric`     | number or integer           | Numeric input                                                           |
| `color`       | string                      | Text input with a hexadecimal color preview                             |
| `path`        | string                      | Text input with Tab completion                                          |
| `combobox`    | string or string-only union | Suggestions from `examples` or union branches, plus custom valid values |
| `json-editor` | any property schema         | Validated JSON editor                                                   |

Pass the annotation as a quoted schema option, as shown by `"x-control": "switch"` in the definition example.

## License

[MIT](https://github.com/zigai/pi-extension-settings/blob/master/LICENSE)
