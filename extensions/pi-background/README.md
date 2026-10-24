# Pi Background Commands

Run shell commands while Pi continues other work. A compact right-aligned status-bar count tracks running shells without adding rows above the input. Completion sends the agent its exit status and output path, waking it if idle.

- **Keep working:** Commands return a job ID immediately.
- **Get notified:** Completion arrives automatically; no polling is needed.
- **Read output:** Inspect recent stdout and stderr or read the full saved log.
- **Stop work:** Cancel a command and its process tree.

## Installation

```sh
pi install npm:@zigai/pi-background
```

## Quick start

Ask Pi:

```text
Run npm test in the background. Continue reviewing the code and tell me when the tests finish.
```

| Tool                | Purpose                                                   |
| ------------------- | --------------------------------------------------------- |
| `background_start`  | Start a command; optionally choose its working directory. |
| `background_status` | Inspect a job's status and recent output by ID.           |
| `background_stop`   | Stop a job by ID.                                         |

The indicator uses the `@zigai/pi-status-bar/api` segment API: `1 shell running` or `2 shells running`, visible while Pi is working or idle and hidden when no shells are running. Load `@zigai/pi-status-bar` to display it; without that extension, tools, notifications, and `/background` still work, with no fallback panel.

Use `/background` to inspect current and finished jobs, read full output in bounded pages (PgUp/PgDn, Home/End, ↑/↓ to scroll, r to refresh, q/Esc to close), or stop a running job. Tool calls use Glowup styling when Glowup is active.

Run commands directly, without appending `&`. Completion waits until the agent finishes its current work before starting a follow-up.

## Job lifetime

Jobs belong to the current Pi session. Switching sessions, reloading extensions, or quitting Pi stops running jobs. Ordinary turn completion leaves them running.

Logs remain under `~/.pi/agent/background/<session-id>/` after jobs end. Each result includes its full output path. Status previews use Pi's normal output limits; full logs are retained until you delete them.

## License

[MIT](LICENSE)
