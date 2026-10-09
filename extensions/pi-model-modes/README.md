# Pi Model Modes

<a href="https://www.npmjs.com/package/@zigai/pi-model-modes"><img alt="npm version" src="https://img.shields.io/npm/v/@zigai/pi-model-modes.svg?color=blue" style="display:inline-block;border:0" /></a> <a href="https://www.npmjs.com/package/@zigai/pi-model-modes"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@zigai/pi-model-modes.svg" style="display:inline-block;border:0" /></a> <a href="https://github.com/zigai/pi-tweaks/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@zigai/pi-model-modes.svg" style="display:inline-block;border:0" /></a>

Mode presets for switching models and thinking levels in Pi.

## Install

```sh
pi install npm:@zigai/pi-model-modes
```

## Features

- Uses `Ctrl+Shift+M` to select and configure modes.
- Supports optional forward and backward shortcuts for cycling modes.
- Colors the prompt editor border from the active mode, with an opt-in setting for thinking-derived border colors.
- Applies an optional persistent default model to fresh sessions without changing it when the session model changes.

Modes can store a provider, model, thinking level, and optional color. Their JSON object order is the exact cycle order; with configured modes, no implicit entries are added. Mode cycling matches the active provider and model, ignoring thinking level, and wraps from the last mode to the first and vice versa. Set `shortcuts.forward` or `shortcuts.backward` to add cycling shortcuts.

Set the persistent default through `Ctrl+Shift+M` → `Configure modes…` → `Set default model…`, or edit `defaultModel` in the configuration file.

<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-model-modes.json`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `version` | number | `1` | Settings format version. |
| `currentMode` | string | `"default"` | Currently selected mode ID. |
| `defaultModel.provider` | string | — | Default model provider. |
| `defaultModel.modelId` | string | — | Default model ID. |
| `defaultModel.thinkingLevel` | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` | — | Pi thinking level for the default model, clamped to that model's capabilities. |
| `modeUseThinkingBorderColors` | boolean | `false` | Use thinking-level colors instead of mode colors for borders. |
| `modeShowThinkingLevelStatus` | boolean | `false` | Show thinking level alongside mode status. |
| `shortcuts.forward` | string | — | Shortcut for cycling modes forward. |
| `shortcuts.backward` | string | — | Shortcut for cycling modes backward. |
| `modes` | Record<string, ModelMode> | `{}` | Named model-mode specifications keyed by mode ID. |

### Defaults

```json
{
  "$schema": "./schemas/pi-model-modes.schema.json",
  "version": 1,
  "currentMode": "default",
  "modeUseThinkingBorderColors": false,
  "modeShowThinkingLevelStatus": false,
  "modes": {}
}
```

### Advanced example

```json
{
  "$schema": "./schemas/pi-model-modes.schema.json",
  "currentMode": "deep",
  "modes": {
    "fast": {
      "provider": "openai-codex",
      "modelId": "gpt-5.4-mini",
      "thinkingLevel": "low",
      "color": "thinkingLow"
    },
    "deep": {
      "provider": "openai-codex",
      "modelId": "gpt-5.6-sol",
      "thinkingLevel": "high",
      "color": "thinkingHigh"
    }
  }
}
```
<!-- pi-extension-settings:end -->

## License

MIT
