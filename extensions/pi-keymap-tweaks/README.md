# Pi Keymap Tweaks

<a href="https://www.npmjs.com/package/@zigai/pi-keymap-tweaks"><img alt="npm version" src="https://img.shields.io/npm/v/@zigai/pi-keymap-tweaks.svg?color=blue" style="display:inline-block;border:0" /></a> <a href="https://www.npmjs.com/package/@zigai/pi-keymap-tweaks"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@zigai/pi-keymap-tweaks.svg" style="display:inline-block;border:0" /></a> <a href="https://github.com/zigai/pi-tweaks/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@zigai/pi-keymap-tweaks.svg" style="display:inline-block;border:0" /></a>

Opinionated editor and message-submit key tweaks for Pi.

## Features

- Makes `Enter` queue a follow-up and `Alt+Enter` steer the current run.
- Normalizes terminal `LF` Enter input to submit correctly in SSH/TMUX sessions.
- Prevents `Up` from recalling prompt history while a non-empty draft is open.
- Uses Pi's configured `app.models.clearAll` key (recommended as `Ctrl+X`) to copy and delete the current editor line.
- Adds Codex-style line start/end behavior for Pi's configured `tui.editor.cursorLineStart` and `tui.editor.cursorLineEnd` actions:
  - line start moves to the previous line when already at column 0
  - line end moves to the next line when already at the current line end
- Matches the omp thinking navigation: `Ctrl+Alt+Left` cycles backward and `Ctrl+Alt+Right` cycles forward, wrapping through the current model's supported Pi levels.
- Supports additional backward shortcuts via extension settings or Pi's `app.thinking.cycleBackward` keybinding. Pi's native forward shortcut remains available.

Unlike omp, Pi does not expose an `auto` thinking level; these shortcuts only select levels supported by Pi.

## Recommended keybindings

The thinking arrow shortcuts are built in. Other key assignments live in your Pi keybindings config.

```json
{
  "tui.editor.cursorWordLeft": ["ctrl+a", "ctrl+left", "alt+left", "alt+b"],
  "tui.editor.cursorWordRight": ["ctrl+d", "ctrl+right", "alt+right", "alt+f"],
  "tui.editor.cursorLineStart": ["home", "ctrl+q"],
  "tui.editor.cursorLineEnd": ["end", "ctrl+e"],
  "tui.editor.jumpBackward": ["ctrl+home"],
  "tui.editor.jumpForward": ["ctrl+end"],
  "tui.editor.undo": ["ctrl+z"],
  "tui.editor.deleteCharForward": ["delete"],
  "app.models.clearAll": ["ctrl+x"],
  "app.thinking.cycleBackward": []
}
```

## Install

```sh
pi install npm:@zigai/pi-keymap-tweaks
```

<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-keymap-tweaks.json`.

| Option                     | Type           | Default | Description                                                                                                 |
| -------------------------- | -------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `cycleThinkingBackwardKey` | string \| null | `null`  | Additional keybinding to cycle thinking backward (e.g. 'alt+shift+tab'). Ctrl+Alt+Left is always available. |

```json
{
  "$schema": "./schemas/pi-keymap-tweaks.schema.json",
  "cycleThinkingBackwardKey": null
}
```
<!-- pi-extension-settings:end -->

## License

MIT
