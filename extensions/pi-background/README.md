# Pi Background Commands

Run tests, builds, and servers in the background while Pi keeps working. When a command ends, its result reaches the agent as a message, even after the agent has finished its turn.

- **Tasks:** Run finite work such as tests and builds. Each task stops at a deadline, 30 minutes by default.
- **Services:** Keep servers and watchers running. The agent checks that they're ready instead of waiting for them to exit.
- **Short waits:** Get results or a progress update after 60 seconds, with commands still running.
- **Output and stop:** Read saved output, or stop a command and its child processes.

## Installation

```sh
pi install npm:@zigai/pi-background
```

## Quick start

Ask Pi:

```text
Run the tests in the background while you review the code. Wait for the results before your final answer.
```

The agent uses these tools:

| Tool                | Purpose                                                                                |
| ------------------- | -------------------------------------------------------------------------------------- |
| `background_start`  | Start a command; optionally choose `cwd`, `kind` (`task` or `service`), and `timeout`. |
| `background_wait`   | Collect all outstanding tasks, or selected task `ids`.                                 |
| `background_status` | Show a job's status and recent output.                                                 |
| `background_stop`   | Stop a job and its child processes.                                                    |

This extension also changes foreground commands. Bash and PowerShell calls are blocked unless they set a timeout of 120 seconds or less. Longer commands belong in a background task.

## Collecting results

When a task or service ends and nothing has collected its result, the result arrives as a message. If the agent is working, it reads the message after its current tool calls. If the agent is idle, the message starts a new turn. The agent is told to end its turn instead of waiting repeatedly.

A wait without `ids` collects every task whose result hasn't been collected yet, including tasks that already finished. Later waits skip those results. Pass `ids` to get a result again.

A result also counts as collected after `background_status` reads a finished task. Stopping a job removes it from default waits, and its output stays readable.

Waits return after 60 seconds by default, and `timeout` accepts 1 to 120 seconds. If tasks are still running, the result sets `timedOut` and includes their current output, run time, and time since their last output. Those tasks keep running, even if you cancel the wait. A task that finishes while a wait is pending is returned by that wait, not as a message.

Waits don't cover services. Check that a service is ready some other way, such as an HTTP request.

## Inspecting jobs

Load `@zigai/pi-status-bar` to show a running count such as `2 shells running`. The tools and `/background` work without it.

Use `/background` to list jobs, read full output, or stop a running job. In the output view, PgUp/PgDn, Home/End, and ↑/↓ scroll, `r` refreshes, and `q` or `Esc` closes. Reading output here doesn't collect it for the agent.

With Glowup active, start calls look like Bash calls, with a `` icon before the duration (requires a Nerd Font). The duration covers the launch, not the command's run time.

## Job lifetime

A task stops with its child processes when its `timeout` passes: 1800 seconds by default, 7200 at most. Its state becomes `timed_out`. Services have no deadline.

Jobs belong to the current Pi session. Switching sessions, reloading extensions, or quitting Pi stops all running jobs. Finishing a turn doesn't.

Logs stay in `~/.pi/agent/background/<session-id>/` until you delete them, and each result includes its log path.

## License

[MIT](LICENSE)
