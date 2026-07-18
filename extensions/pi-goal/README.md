# Pi Codex Goal

`pi-codex-goal` is a Pi extension inspired by the Codex CLI goal feature. It keeps an agent working
toward a durable objective across turns, tool calls, session reloads, and context compaction. An
active goal continues until it is completed, paused, blocked, or stopped by an optional time limit.

- Turn a plain task into a model-expanded completion contract, or preserve exact wording.
- Keep goal state in session history so it follows resume, fork, and tree navigation.
- Pause, resume, adjust, block, complete, or time-limit ongoing work.
- Let models manage goals through `get_goal`, `create_goal`, and `update_goal`.

## Install

The package requires Node.js 24 or newer. Install the current npm release with Pi:

```sh
pi install npm:pi-codex-goal
```

Append `@<version>` to the package name when you need a specific release.

## Quick start

Enter a concrete outcome in Pi:

```text
/goal Upgrade session authentication to reject expired credentials, add regression tests, and run the full test suite.
```

The model expands the task into a goal, pursues it while the goal remains active, and marks it
complete only after verifying the requested outcome. Run `/goal` with no arguments to inspect its
current status and usage.

Use raw mode when your text is already the exact objective to store:

```text
/goal -r Keep the release workflow green and report every verified failure.
```

## Commands

| Command                | Effect                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `/goal`                | Show the current objective, status, constraints, elapsed active time, and token usage. |
| `/goal <task>`         | Ask the model to expand and create a goal from the task.                               |
| `/goal -r <objective>` | Store the objective exactly as written.                                                |
| `/goal pause`          | Pause an active goal.                                                                  |
| `/goal resume`         | Resume a paused or blocked goal.                                                       |

Starting a new goal while another non-terminal goal exists asks for confirmation when Pi has an
interactive UI.

### Expanded options

Before submitting a completed `/goal ...` command, press **Tab twice** to open its expanded form.
Use **Up/Down** to move between fields.

| Option              | Default  | Effect                                                                    |
| ------------------- | -------- | ------------------------------------------------------------------------- |
| Wording             | `expand` | Choose model-expanded wording or preserve the exact task text.            |
| Minimum active time | unset    | Prevent completion until the requested active time has accrued.           |
| Maximum active time | unset    | Stop automatic work when the active-time limit is reached.                |
| Adjust current goal | `no`     | Replace a mutable goal's objective without resetting its status or usage. |

Time constraints and objective adjustment are available only in the expanded form.

## Configuration

On first session start, the extension creates its global configuration at
`~/.pi/agent/pi-codex-goal/config.json`.

| Option                         | Type           | Default | Description                                                            |
| ------------------------------ | -------------- | ------- | ---------------------------------------------------------------------- |
| `creationPromptPath`           | string or null | `null`  | Use a custom goal-creation template. `null` uses the bundled template. |
| `disabledToolsWhileGoalActive` | string[]       | `[]`    | Disable the named registered tools only while a goal is active.        |

The complete default configuration is:

```json
{
  "$schema": "./config.schema.json",
  "creationPromptPath": null,
  "disabledToolsWhileGoalActive": []
}
```

Reload Pi after changing the disabled-tool list. The extension restores each affected tool to its
previous state when the goal stops being active. `get_goal` and `update_goal` must remain available.

See [Configuration](docs/configuration.md) for custom templates and trusted-project overrides.

## Model tools

| Tool          | Purpose                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `get_goal`    | Inspect the current goal, constraints, status, and usage.                                          |
| `create_goal` | Create a goal with optional whole-minute minimum and maximum active times.                         |
| `update_goal` | Mark the current goal `complete` after verification or `blocked` when work cannot safely continue. |

In bridged MCP environments, Pi may expose these tools with names such as `pi__get_goal`,
`pi__create_goal`, and `pi__update_goal`.

## Goal lifecycle

- Active goals continue automatically when Pi is idle and substantive work remains.
- Aborting an active assistant turn pauses the goal.
- Paused and blocked goals retain their objective and usage until explicitly resumed.
- Maximum-time goals stop automatic work; minimum time prevents premature completion.
- Token usage is informational and never acts as a goal budget.

## Documentation

- [Goal commands and lifecycle](docs/usage.md)
- [Configuration](docs/configuration.md)
- [Platform smoke testing](docs/platform-smoke.md)

## License

[MIT](LICENSE)
