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
- Uses the first configured cycle mode for fresh startup and `/new`, including its thinking level and border appearance.
- Preserves the selected model and thinking level when resuming, forking, or reloading a session.

Modes can store a provider, model, thinking level, and optional color. Their JSON object order is the exact cycle order; with configured modes, no implicit entries are added. Mode cycling matches the active provider and model, ignoring thinking level, and wraps from the last mode to the first and vice versa. Set `shortcuts.forward` or `shortcuts.backward` to add cycling shortcuts.

The first mode is marked **(startup)** in the picker. To change startup selection, use `Ctrl+Shift+M` → `Configure modes…` → select a mode → `Move to first / use on startup`, or reorder the `modes` object in the configuration file. Reordering does not switch the active session; it takes effect on the next fresh session. New modes append to the cycle, renaming preserves position, and deleting the first mode makes the next one the startup mode.

With no configured modes, Pi retains its normal model selection. If the first mode's model is unavailable or lacks credentials, Pi retains its selection and the extension warns instead of silently choosing another mode. Unset model/thinking fields retain their existing meaning: do not change that part of the selection.

### Legacy startup setting

`defaultModel` is accepted for compatibility but no longer controls startup. The first configured cycle mode wins even when `currentMode` or the legacy default points elsewhere. A differing legacy default produces an informational notice once per extension instance. Loading does not rewrite your existing settings; explicitly saving mode configuration removes the deprecated field. Trusted-project settings merge mode fields with global settings. Mode names explicitly declared in the project lead the effective cycle in project order; remaining inherited modes follow in global order. Startup and cycling use that same effective order.

Mode picker pins are independent UI settings and are not changed automatically.

<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-model-modes.json`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `version` | number | `1` | Settings format version. |
| `currentMode` | string | `"default"` | Currently selected mode ID. |
| `defaultModel.provider` | string | — | Legacy startup model provider; ignored. The first cycle mode is used instead. |
| `defaultModel.modelId` | string | — | Legacy startup model ID; ignored. The first cycle mode is used instead. |
| `defaultModel.thinkingLevel` | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` | — | Pi thinking level for the default model, clamped to that model's capabilities. |
| `modeUseThinkingBorderColors` | boolean | `false` | Use thinking-level colors instead of mode colors for borders. |
| `modeShowThinkingLevelStatus` | boolean | `false` | Show thinking level alongside mode status. |
| `shortcuts.forward` | string | — | Shortcut for cycling modes forward. |
| `shortcuts.backward` | string | — | Shortcut for cycling modes backward. |
| `deletedModes` | string[] | — | Global mode names hidden by this project configuration. |
| `modes` | Record<string, [ModelMode](#settings-type-ModelMode)> | `{}` | Named model modes in cycle order. The first configured mode is used on fresh startup and /new; resumed sessions keep their selection. |

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

### Structural types

<a id="settings-type-ModelMode"></a>

#### ModelMode

Additional fields are not allowed.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `provider` | string | No |  |
| `modelId` | string | No |  |
| `thinkingLevel` | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` \| null | No | Pi thinking level for this mode; null clears an inherited project value. |
| `color` | string | No | Pi theme foreground color used for this mode. |
<!-- pi-extension-settings:end -->

## License

MIT
