# Pi Status Bar

<a href="https://www.npmjs.com/package/@zigai/pi-status-bar"><img alt="npm version" src="https://img.shields.io/npm/v/@zigai/pi-status-bar.svg?color=blue" style="display:inline-block;border:0" /></a> <a href="https://www.npmjs.com/package/@zigai/pi-status-bar"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@zigai/pi-status-bar.svg" style="display:inline-block;border:0" /></a> <a href="https://github.com/zigai/pi-tweaks/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@zigai/pi-status-bar.svg" style="display:inline-block;border:0" /></a>

Adds a coherent programmable status bar to Pi:

- active working-line status with spinner, text, elapsed time, and optional right-side messages
- idle post-run status with tool-time-excluding model throughput, such as `Worked for 1m 12s. [45.0 tok/s]`
- an extension API for changing active text, spinner frames, timer state, idle text, and custom status segments

This package intentionally stays single-line and status-focused. For richer UI above the editor, use Pi's built-in API's.

## Install

```sh
pi install npm:@zigai/pi-status-bar
```

<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-status-bar.json`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `statusBar.active.text` | string | — | Custom active status text. |
| `statusBar.active.spinner.frames` | string[] | — | Spinner frames displayed while Pi is active. |
| `statusBar.active.timer.visible` | boolean | `true` | Show the active-run timer. |
| `statusBar.active.timer.paused` | boolean | `false` | Display the active-run timer as paused. |
| `statusBar.idle.text` | string | — | Custom idle status text. |
| `statusBar.idle.visible` | boolean | `true` | Show the status bar while Pi is idle. |
| `statusBar.idle.showLastRunSummary` | boolean | `true` | Show the previous run summary while idle. |
| `statusBar.idle.showTokensPerSecond` | boolean | `true` | Show model token throughput in the previous run summary. |
| `rightMessages.enabled` | boolean | `false` | Enable rotating messages on the right side. |
| `rightMessages.intervalMs` | integer | `10000` | Delay between rotating messages in milliseconds. |
| `rightMessages.minGap` | integer | `4` | Minimum spaces between repeated scrolling messages. |
| `rightMessages.minScrollCycles` | integer | `1` | Minimum completed scroll cycles before advancing. |
| `rightMessages.scrollColumnIntervalMs` | integer | `120` | Delay between horizontal scroll columns in milliseconds. |
| `rightMessages.dimmed` | boolean | `true` | Render rotating messages with dim styling. |
| `rightMessages.italic` | boolean | `true` | Render rotating messages with italic styling. |
| `rightMessages.messages` | string[] | `[]` | Inline rotating status messages. |
| `rightMessages.messagesFile` | string | — | Path to a newline-delimited messages file. |

```json
{
  "$schema": "./schemas/pi-status-bar.schema.json",
  "statusBar": {
    "active": {
      "timer": {
        "visible": true,
        "paused": false
      }
    },
    "idle": {
      "visible": true,
      "showLastRunSummary": true,
      "showTokensPerSecond": true
    }
  },
  "rightMessages": {
    "enabled": false,
    "intervalMs": 10000,
    "minGap": 4,
    "minScrollCycles": 1,
    "scrollColumnIntervalMs": 120,
    "dimmed": true,
    "italic": true,
    "messages": []
  }
}
```
<!-- pi-extension-settings:end -->

## Extension API

Other extensions can program the active and idle status bar through `@zigai/pi-status-bar/api`.

```ts
import { configureStatusBar, registerStatusBarSegment } from "@zigai/pi-status-bar/api";

const statusBar = configureStatusBar({
  active: {
    text: "Searching docs",
    spinner: { frames: ["◐", "◓", "◑", "◒"] },
  },
  idle: {
    text: "Ready",
    showLastRunSummary: true,
  },
});

statusBar.pauseTimer();
statusBar.resumeTimer();
statusBar.resetTimer();
statusBar.setActiveText("Running tests");
statusBar.setIdleText("Last run finished");
statusBar.dispose();
```

Custom segments can appear in the active line, idle line, or both.

```ts
const segment = registerStatusBarSegment({
  id: "my-extension.status",
  states: ["active", "idle"],
  side: "right",
  text: "review",
  priority: 50,
});

segment.setText("typechecking");
segment.clear();
segment.dispose();
```

## License

MIT
