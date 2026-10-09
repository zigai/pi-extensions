# Pi Tree

<a href="https://www.npmjs.com/package/@zigai/pi-tree"><img alt="npm version" src="https://img.shields.io/npm/v/@zigai/pi-tree.svg?color=blue" style="display:inline-block;border:0" /></a> <a href="https://www.npmjs.com/package/@zigai/pi-tree"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@zigai/pi-tree.svg" style="display:inline-block;border:0" /></a> <a href="https://github.com/zigai/pi-tweaks/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@zigai/pi-tree.svg" style="display:inline-block;border:0" /></a>

A cleaner, more informative `/tree` for Pi.

## Install

```sh
pi install npm:@zigai/pi-tree
```

## Features

- Shows per-entry timestamps in `/tree`.
- Supports `off`, `relative`, and `absolute` timestamp modes.
- Uses Pi's configured tree label-timestamp keybinding, commonly `Shift+T`, to cycle timestamp modes.
- Adds an optional selected-entry preview pane on the right side of `/tree` when the terminal is wide enough.
- Toggles the preview pane with `Shift+P`.
- Reads timestamp and preview choices from config.
- Can make `/tree` taller with `treeMaxVisibleLines`.
- Can keep the preview pane at full height or shrink it to fit preview content.

![Pi Tree preview demo](assets/tree-preview-demo.png)

<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-tree.json`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `treeTimestampMode` | `off` \| `relative` \| `absolute` | `"relative"` | Timestamp style shown in tree entries. |
| `treeSelectedPreview` | boolean | `false` | Show the selected tree entry preview. |
| `treeMaxVisibleLines` | number | — | Maximum visible lines in the tree selector. |
| `treePreviewFullHeight` | boolean | `true` | Allow the preview to use the selector's full available height. |

```json
{
  "$schema": "./schemas/pi-tree.schema.json",
  "treeTimestampMode": "relative",
  "treeSelectedPreview": false,
  "treePreviewFullHeight": true
}
```
<!-- pi-extension-settings:end -->

## Development

```sh
npm install
npm run check
```

## License

MIT
