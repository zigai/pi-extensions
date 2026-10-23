# Pi Background Commands

Run shell commands while Pi continues other work. A compact panel above the working indicator tracks each job. Completion sends the agent its exit status and output path, waking it if idle.

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

Use `/background` to read full output in bounded pages (PgUp/PgDn, Home/End, ↑/↓ to scroll, r to refresh, q/Esc to close), stop a running job, or dismiss a finished row. The panel stays pinned as chat scrolls and coexists with subagent progress. Tool calls use Glowup styling when Glowup is active.

Run commands directly, without appending `&`. Completion waits until the agent finishes its current work before starting a follow-up.

## Job lifetime

Jobs belong to the current Pi session. Switching sessions, reloading extensions, or quitting Pi stops running jobs. Ordinary turn completion leaves them running.

Logs remain under `~/.pi/agent/background/<session-id>/` after jobs end. Each result includes its full output path. Status previews use Pi's normal output limits; full logs are retained until you delete them.

## License

[MIT](LICENSE)
