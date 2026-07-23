# Pi Settings UI

Edit extension-owned Pi settings through a schema-driven terminal interface. The editor discovers
the generated schemas installed by [`@zigai/pi-extension-settings`](https://github.com/zigai/pi-extension-settings) and turns them into validated,
reusable controls.

- Pi's regular settings selector as the first tab, followed by one tab per extension.
- A compact active-tab header and searchable Ctrl+P switcher that scale to large extension sets.
- Global and trusted-project scopes for extension-owned settings.
- Native toggles, searchable choices, sliders, path completion, color previews, text, and number
  controls plus nested editors for lists, records, maps, and unions.
- Humanized, grouped labels with aligned values, descriptions, constraints, and override state.
- Atomic, conflict-checked saves that leave malformed settings untouched.

## Install

```sh
pi install npm:@zigai/pi-settings-ui
```

## Schema controls

Extension schemas may use the optional `x-control` JSON Schema keyword to state presentation intent
that ordinary types and constraints cannot express. With TypeBox, pass it as a quoted schema option:

```ts
Type.String({ "x-control": "textarea" });
Type.String({ "x-control": "path" });
Type.Integer({ minimum: 1, maximum: 20, "x-control": "slider" });
Type.String({ "x-control": "combobox", examples: ["accent", "warning"] });
```

| `x-control` | Compatible schema | TUI behavior |
| --- | --- | --- |
| `text` | string | Single-line inline input. |
| `textarea` | string | Pi's multiline editor. |
| `switch` | boolean | Boolean toggle. |
| `segmented` | primitive choices | Compact choice changed with Left and Right. |
| `select` | primitive choices | Searchable choice picker. |
| `slider` | number or integer | Compact range bar; Left and Right step by `multipleOf` or the numeric default, while Enter accepts an exact value. |
| `numeric` | number or integer | Single-line numeric input. |
| `color` | string | Single-line color input with a live swatch for hexadecimal colors. |
| `path` | string | Single-line path input; Tab completes files and directories relative to Pi's working directory or `~`. |
| `combobox` | string or string-only union | Searchable suggestions from string `examples` or finite string branches, plus a custom schema-validated value. |
| `json-editor` | any schema | Full validated JSON editor instead of a shape-derived control. |

<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-settings-ui.json`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `projectOverrides` | boolean | `true` | Let trusted projects have their own extension settings. |

```json
{
  "$schema": "./schemas/pi-settings-ui.schema.json",
  "projectOverrides": true
}
```
<!-- pi-extension-settings:end -->

## Development

```sh
just setup
just coverage
```

## License

[MIT](LICENSE)
