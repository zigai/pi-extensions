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
      enabled: Type.Boolean({
        default: true,
        description: "Enable the extension.",
        "x-control": "switch",
      }),
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

### Optional TUI control hints

TypeBox preserves custom JSON Schema annotations in the generated schema. Extension authors can use
the optional `x-control` keyword to tell compatible settings editors how a property should be
presented when its ordinary JSON Schema shape is ambiguous. The annotation does not change runtime
validation, defaults, or loading behavior.

[Pi Settings UI](https://github.com/zigai/pi-settings-ui) recognizes these values:

| `x-control`   | Compatible schema           | TUI behavior                                                                                                      |
| ------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `text`        | string                      | Single-line inline input.                                                                                         |
| `textarea`    | string                      | Pi's multiline editor.                                                                                            |
| `switch`      | boolean                     | Boolean toggle.                                                                                                   |
| `segmented`   | primitive choices           | Compact choice changed with Left and Right.                                                                       |
| `select`      | primitive choices           | Searchable choice picker.                                                                                         |
| `slider`      | number or integer           | Compact range bar with stepping and exact-number entry. Schema bounds and `multipleOf` refine its range and step. |
| `numeric`     | number or integer           | Single-line numeric input.                                                                                        |
| `color`       | string                      | Single-line color input with a live swatch for hexadecimal colors.                                                |
| `path`        | string                      | Single-line path input with Tab completion.                                                                       |
| `combobox`    | string or string-only union | Searchable suggestions from string `examples` or finite string branches, plus a custom schema-validated value.    |
| `json-editor` | any property schema         | Full validated JSON editor instead of a shape-derived control.                                                    |

Pass the annotation as a quoted TypeBox option:

```ts
const schema = Type.Object({
  prompt: Type.String({ "x-control": "textarea" }),
  root: Type.String({ "x-control": "path" }),
  limit: Type.Integer({ minimum: 1, maximum: 20, "x-control": "slider" }),
  color: Type.String({
    "x-control": "combobox",
    examples: ["accent", "warning"],
  }),
});
```

Hints are optional. Pi Settings UI infers switches from booleans, segmented controls from up to six
primitive choices, searchable selects from larger choice sets, sliders from numbers with both
bounds, and text or textarea controls from string defaults, examples, and length constraints.
`format: "path"` and `format: "color"` also select those string controls. Unknown or
type-incompatible hints fall back to this inference.

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

`generate` writes `config.schema.json` and adds or updates the generated configuration section in the README. Compact defaults stay in the option table; larger exact defaults remain available in a collapsed complete-settings block.

`check` verifies that both artifacts are up to date without changing files, making it suitable for pre-commit and CI.

## License

[MIT](https://github.com/zigai/pi-extension-settings/blob/master/LICENSE)
