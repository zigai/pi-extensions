# Pi Settings Ui

## Install

```sh
pi install npm:@zigai/pi-settings-ui
```

## Extension

The Pi extension entrypoint in `src/index.ts` loads and validates extension settings at session start.
<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-settings-ui.json`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Enable the extension. |

```json
{
  "$schema": "./schemas/pi-settings-ui.schema.json",
  "enabled": true
}
```
<!-- pi-extension-settings:end -->

## Development

```sh
just setup
just coverage
```
