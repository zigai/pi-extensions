# Pi Settings UI

Edit extension-owned Pi settings through a schema-driven terminal interface. The editor discovers
the generated schemas installed by [`@zigai/pi-extension-settings`](https://github.com/zigai/pi-tweaks/tree/master/packages/pi-extension-settings) and turns them into validated,
reusable controls.

- Visible tabs with Pi pinned first, overflow arrows, and a More picker (Ctrl+P by default).
- Ctrl+F searches settings across Pi and extensions; Ctrl+S chooses a searchable scope.
- Global and trusted-project save scopes, separate from the search scope.
- Native toggles, searchable choices, sliders, path completion, color previews, text, and number
  controls plus nested editors for lists, records, maps, and unions.
- Humanized, grouped labels with aligned values, descriptions, constraints, and override state.
- Atomic, conflict-checked saves that leave malformed settings untouched.

Pi 0.84 renderer mode and fullscreen scrollbar changes are saved from the Pi tab and take effect in
the next Pi session. Pi does not currently expose live renderer switching to extensions.

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
| `header.layout` | `stacked` \| `compact` | `"stacked"` | Separate navigation and scope, or combine them when space allows. |
| `header.showHints` | boolean | `true` | Show the tab-picker shortcut in the settings header. |
| `header.showFieldCounter` | boolean | `true` | Show the current field position in the settings header. |
| `tabPickerShortcut` | string | `"ctrl+p"` | Key for the settings-tab picker, using Pi key names such as ctrl+shift+p. |
| `projectOverrides` | boolean | `true` | Let trusted projects have their own extension settings. |

```json
{
  "$schema": "./schemas/pi-settings-ui.schema.json",
  "header": {
    "layout": "stacked",
    "showHints": true,
    "showFieldCounter": true
  },
  "tabPickerShortcut": "ctrl+p",
  "projectOverrides": true
}
```
<!-- pi-extension-settings:end -->

## Development

```sh
just --justfile ../../Justfile setup
npm run build --prefix ../..
just coverage
```

## License

[MIT](LICENSE)
