# Goal commands and lifecycle

`pi-codex-goal` provides one interactive command and three model-callable tools. Goal state is
stored in Pi session history, so it follows the selected branch through resume, fork, tree
navigation, reload, and compaction.

## Commands

| Command                | Effect                                                                          |
| ---------------------- | ------------------------------------------------------------------------------- |
| `/goal`                | Show the current goal, status, constraints, active time, and token usage.       |
| `/goal <task>`         | Render the goal-creation template and ask the model to create an expanded goal. |
| `/goal -r <objective>` | Create a goal with the exact supplied wording.                                  |
| `/goal pause`          | Pause an active goal.                                                           |
| `/goal resume`         | Resume a paused or blocked goal.                                                |

Only `pause` and `resume` are reserved management tasks. Raw mode always treats its argument as an
objective. Starting a new goal replaces a completed goal directly; replacing another non-terminal
goal requires confirmation when an interactive UI is available.

Generated goal creation gives the model the task, current directory, optional time constraints,
and current-goal context. The model turns that input into a concrete completion contract and calls
`create_goal` with explicit replacement enabled.

## Expanded form

With an unsubmitted `/goal ...` command in Pi's editor, press **Tab twice** to open the expanded
form. Use **Up/Down** to move between fields, **Left/Right** or **Space** to change boolean choices,
and **Enter** to submit.

| Field               | Effect                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Goal                | Edit the task used for generated or exact goal creation.                                                   |
| Wording             | Choose `expand` or `exact`.                                                                                |
| Minimum active time | Require a positive whole number of active minutes before completion.                                       |
| Maximum active time | Stop automatic work after a positive whole number of active minutes.                                       |
| Adjust current goal | Edit a paused, blocked, or active objective without resetting its identity, status, constraints, or usage. |

Time constraints and adjustment are form-only. Completed and time-limited goals cannot be adjusted;
start a replacement goal instead.

## Model tools

### `get_goal`

Returns the current objective, lifecycle status, active-time constraints, elapsed active time, and
informational token usage.

### `create_goal`

Creates an active goal with these parameters:

| Parameter              | Type             | Required | Effect                                                                                |
| ---------------------- | ---------------- | -------- | ------------------------------------------------------------------------------------- |
| `objective`            | string           | yes      | The concrete objective to pursue.                                                     |
| `minimum_time_minutes` | positive integer | no       | Minimum active time required before completion.                                       |
| `maximum_time_minutes` | positive integer | no       | Maximum active time before automatic work stops.                                      |
| `replace_existing`     | boolean          | no       | Replace an existing non-complete goal when the user explicitly requested replacement. |

A completed goal can be replaced without `replace_existing`. A non-complete goal cannot be replaced
through the tool unless `replace_existing: true` is supplied.

### `update_goal`

Accepts `status: "complete"` or `status: "blocked"`:

- `complete` succeeds only after the work is verified and any minimum active time has elapsed.
- `blocked` is valid only for an active goal when no safe in-scope path remains without unavailable
  input, authority, access, or dependencies.

Repeating the same terminal update is idempotent. In bridged MCP environments, Pi may expose goal
tools under names such as `pi__get_goal`, `pi__create_goal`, and `pi__update_goal`.

## Lifecycle states

| Status        | Meaning                                                                | Next user action                                                       |
| ------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `active`      | Pi continues the goal when it is idle and work remains.                | Pause it, replace it, or let the model finish or block it.             |
| `paused`      | Automatic work is stopped while the objective and usage remain stored. | Run `/goal resume` or replace the goal.                                |
| `blocked`     | Work needs unavailable input, authority, access, or dependencies.      | Resolve the blocker, then run `/goal resume`.                          |
| `timeLimited` | Maximum active time was reached and automatic work stopped.            | Inspect or replace it; it may still be marked complete after an audit. |
| `complete`    | The model reported evidence-backed completion.                         | Inspect it or start a replacement goal.                                |

Aborting an active assistant turn pauses the goal. On session resume, Pi asks before reactivating a
paused goal. Blocked goals never resume automatically.

## Continuation and accounting

- Active goals receive hidden continuation prompts when Pi is idle and substantive work remains.
- Every automatic continuation identifies the current goal and includes its exact escaped objective.
- Active time accrues during goal work. A minimum prevents early completion, while a maximum changes
  the goal to `timeLimited` at the next accounting checkpoint.
- Token usage is completed assistant-turn input plus output usage. It is informational and never
  limits a goal.
- Provider retries and context-overflow compaction remain owned by the Pi host. The extension
  preserves goal state around recovery and resumes only after the host path settles.
- Runtime persistence is coalesced, while meaningful usage is flushed at turn boundaries,
  compaction, shutdown, time-limit crossings, and bounded intervals during long tool-heavy runs.

Objectives are limited to 8,000 Unicode characters.

## Design references

- [Follow a goal](https://developers.openai.com/codex/use-cases/follow-goals)
- [Using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)
