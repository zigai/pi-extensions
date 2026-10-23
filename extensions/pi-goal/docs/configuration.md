# Configuration

On first session start, `@zigai/pi-goal` creates the global settings file and its JSON Schema:

```text
~/.pi/agent/pi-codex-goal/config.json
~/.pi/agent/pi-codex-goal/config.schema.json
```

## Options

| Option                         | Type           | Default | Description                                                                                      |
| ------------------------------ | -------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `creationPromptPath`           | string or null | `null`  | Absolute template path, or a path relative to the config file. `null` uses the bundled template. |
| `disabledToolsWhileGoalActive` | string[]       | `[]`    | Additional tool names to disable while a goal is active.                                         |

The complete default configuration is:

```json
{
  "$schema": "./config.schema.json",
  "creationPromptPath": null,
  "disabledToolsWhileGoalActive": []
}
```

Unknown options and invalid values are rejected rather than silently ignored.

## Active-goal tool restrictions

`ask_user_question` is always blocked during active goal work, including supported nested calls.
Set `disabledToolsWhileGoalActive` for additional restrictions. For example:

```json
{
  "$schema": "./config.schema.json",
  "creationPromptPath": null,
  "disabledToolsWhileGoalActive": ["browser"]
}
```

The policy applies only while a goal is `active`. When it pauses, blocks, completes, or reaches its
maximum time, remaining Toggles policy resumes, or standalone prior states are restored. Tools
registered later are also restricted before agent work and when invoked.

`get_goal` and `update_goal` cannot be disabled because the active lifecycle depends on them. A
disabled-tool list may contain at most 128 non-empty names. Reload Pi after changing this option.

## Custom goal-creation templates

Set `creationPromptPath` to an absolute path or a path relative to the config file that declares it.
The template is reread for every generated `/goal` invocation, so editing the selected template does
not require a reload.

Templates support these attributes:

| Attribute                | Required | Value                                                 |
| ------------------------ | -------- | ----------------------------------------------------- |
| `{{task}}`               | yes      | The task supplied to `/goal`.                         |
| `{{constraints}}`        | yes      | Rendered minimum and maximum active-time constraints. |
| `{{cwd}}`                | no       | Pi's current working directory.                       |
| `{{currentGoal}}`        | no       | The current goal or an explicit no-goal marker.       |
| `{{minimumTimeMinutes}}` | no       | The minimum whole-minute value or an unset marker.    |
| `{{maximumTimeMinutes}}` | no       | The maximum whole-minute value or an unset marker.    |

Unknown attributes are rejected. User-controlled task, directory, and current-goal values are
XML-escaped before interpolation.

## Trusted-project overrides

A trusted project can provide a partial override at:

```text
.pi/pi-codex-goal/config.json
```

Project values override global values one option at a time; omitted options continue to use the
global value. Relative template paths resolve from the config file that supplied the path. The
extension never reads a project override when Pi does not trust that project.
