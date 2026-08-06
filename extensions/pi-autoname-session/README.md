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
| `initialNaming.trigger` | `messages` \| `turns` \| `tool_calls` \| `tokens` \| `minutes` | `"messages"` | The session activity that starts a naming attempt. |
| `initialNaming.threshold` | integer | `1` | The initial activity threshold. |
| `refreshNaming.enabled` | boolean | `false` | Periodically refresh the name as the session develops. |
| `refreshNaming.trigger` | `messages` \| `turns` \| `tool_calls` \| `tokens` \| `minutes` | `"turns"` | The activity that starts a naming refresh. |
| `refreshNaming.threshold` | integer | `10` | The amount of activity between refreshes. |
| `model` | string | `"current"` | Picker model in provider/model-id form, or current to use the session's active model. |
| `reasoningEffort` | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` | `"low"` | Reasoning effort used by the session-name picker. |
| `timeoutMs` | integer | `30000` | Maximum time in milliseconds for picker authentication and the model response before the naming attempt is treated as failed. |
| `conversationScope` | `minimized` \| `full` | `"minimized"` | How much of the session conversation is sent to the picker model. Minimized sends user messages, assistant text, tool names, and compaction or branch summaries; full also sends tool arguments, tool results, and shell output. Use Minimized when the picker model is a different provider from the session model. |
| `prompt` | string | *See JSON below ↓* | Prompt used by the picker. Available placeholders are {{repository_context}}, {{conversation}}, {{current_name}}, {{cwd}}, and {{reason}}. |
| `nameConstraints.minLength` | integer | `6` | Minimum number of characters in a name returned by the picker. |
| `nameConstraints.maxLength` | integer | `60` | Maximum number of characters in a name returned by the picker. |

```json
{
  "$schema": "./schemas/pi-autoname-session.schema.json",
  "enabled": true,
  "initialNaming": {
    "enabled": true,
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

Each naming attempt sends a rendered prompt to the configured `model` (the picker). The prompt contains:

- the working directory and any loaded repository guidance files;
- conversation content from the session, in the shape selected by `conversationScope`;
- the current session name, the working directory, and the naming reason;
- the rendered `prompt` template with the `{{...}}` placeholders substituted.

With `conversationScope: "minimized"` (the default), only user messages, assistant text, tool names, and compaction or branch summaries are sent; tool arguments, tool results, and shell output are excluded. With `"full"`, tool arguments, tool results, and shell output are also included. Compacted-away history is never resent: the picker receives the active, compaction-aware entry list.

When `model` is `"current"`, the picker is the same model that already sees the session conversation. When a separate picker provider is configured, conversation content is transmitted to that provider; keep `conversationScope: "minimized"` unless you trust the picker provider with tool and shell output.

## Development

```sh
just setup
just coverage
```

## License

[MIT](LICENSE)
