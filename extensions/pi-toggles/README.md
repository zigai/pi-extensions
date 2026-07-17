# Pi Toggles

## Install

```sh
pi install npm:@zigai/pi-toggles
```

## Extension

The Pi extension entrypoint in `src/index.ts` loads and validates extension settings at session start.
<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-toggles.json`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Enable the extension. |

```json
{
  "$schema": "./schemas/pi-toggles.schema.json",
  "enabled": true
}
```
<!-- pi-extension-settings:end -->

## Development

```sh
just setup
just coverage
```
