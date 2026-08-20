# Pi Autoname Session

Automatically name Pi sessions from the user's request and repository context.

The extension can name a session after a configurable activity threshold and optionally refresh that name as work continues.

## Install

```sh
pi install npm:@zigai/pi-autoname-session
```

<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-autoname-session.json`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Enable the extension. |
| `initialNaming.enabled` | boolean | `true` | Automatically name an otherwise unnamed session once. |
| `initialNaming.timing` | `prompt` \| `settled` | `"prompt"` | When to first check the naming trigger: before the agent starts on a prompt, or after the agent has settled. |
| `initialNaming.trigger` | `messages` \| `turns` \| `tool_calls` \| `tokens` \| `minutes` | `"messages"` | The session activity that starts a naming attempt. |
| `initialNaming.threshold` | integer | `1` | The initial activity threshold. |
| `refreshNaming.enabled` | boolean | `false` | Periodically refresh the name as the session develops. |
| `refreshNaming.trigger` | `messages` \| `turns` \| `tool_calls` \| `tokens` \| `minutes` | `"turns"` | The activity that starts a naming refresh. |
| `refreshNaming.threshold` | integer | `10` | The amount of activity between refreshes. |
| `model` | string | `"current"` | Picker model: provider/model-id, or current for the active model. |
| `reasoningEffort` | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` | `"low"` | Reasoning effort used by the session-name picker. |
| `timeoutMs` | integer | `30000` | Maximum time in milliseconds for picker authentication and the model response before the naming attempt is treated as failed. |
| `conversationScope` | `minimized` \| `full` | `"minimized"` | How much conversation to send to the picker. Minimized omits tool arguments, results, and shell output; full includes them. |
| `prompt` | string | *See JSON below* | Prompt used by the picker. Available placeholders are {{repository_context}}, {{conversation}}, {{current_name}}, {{cwd}}, and {{reason}}. |
| `nameConstraints.minLength` | integer | `6` | Minimum number of characters in a name returned by the picker. |
| `nameConstraints.maxLength` | integer | `60` | Maximum number of characters in a name returned by the picker. |

```json
{
  "$schema": "./schemas/pi-autoname-session.schema.json",
  "enabled": true,
  "initialNaming": {
    "enabled": true,
    "timing": "prompt",
    "trigger": "messages",
    "threshold": 1
  },
  "refreshNaming": {
    "enabled": false,
    "trigger": "turns",
    "threshold": 10
  },
  "model": "current",
  "reasoningEffort": "low",
  "timeoutMs": 30000,
  "conversationScope": "minimized",
  "prompt": "Your goal is to pick a coding session name for quick recognition in a session list.\nUse the repository context and conversation to identify the main goal or workstream.\nPrefer a specific, useful phrase over a generic one.\nReturn only the name; do not include quotes, Markdown, or an explanation.\n\nRepository context:\n<repository_context>\n{{repository_context}}\n</repository_context>\n\nConversation:\n<conversation>\n{{conversation}}\n</conversation>\n\nCurrent name: {{current_name}}",
  "nameConstraints": {
    "minLength": 6,
    "maxLength": 60
  }
}
```
<!-- pi-extension-settings:end -->

## Data flow and privacy

The picker receives the working directory, repository guidance, current name, reason, and active conversation. `minimized` excludes tool arguments, results, and shell output; `full` includes them, including for separate providers.

## Development

```sh
just setup
just coverage
```

## License

[MIT](LICENSE)
