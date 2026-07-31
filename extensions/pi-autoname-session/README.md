# Pi Autoname Session

Automatically name Pi sessions from the user's request and repository context.

The extension can name a session after a configurable activity threshold and optionally refresh that name as work continues. The picker model, reasoning effort, prompt, trigger, and name length are all configurable.

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
| `initialNaming.threshold` | number | `1` | The initial activity threshold. The default names the session after its first user message has been processed. |
| `refreshNaming.enabled` | boolean | `false` | Periodically refresh the name as the session develops. |
| `refreshNaming.trigger` | `messages` \| `turns` \| `tool_calls` \| `tokens` \| `minutes` | `"turns"` | The activity that starts a naming refresh. |
| `refreshNaming.threshold` | number | `10` | The amount of activity between refreshes. |
| `model` | string | `"current"` | Picker model in provider/model-id form, or current to use the session's active model. |
| `reasoningEffort` | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` | `"low"` | Reasoning effort used by the session-name picker. |
| `prompt` | string | *See JSON below ↓* | Prompt used by the picker. Available placeholders are {{repository_context}}, {{conversation}}, {{current_name}}, {{cwd}}, and {{reason}}. |
| `nameConstraints.minLength` | number | `3` | Minimum length of a name returned by the picker. |
| `nameConstraints.maxLength` | number | `60` | Maximum length of a name returned by the picker. |

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
  "prompt": "You name coding sessions for quick recognition in a session list.\nUse the repository context and conversation to identify the main goal or workstream.\nPrefer a specific, useful phrase over a generic one.\nReturn only the name; do not include quotes, Markdown, or an explanation.\n\nRepository context:\n<repository_context>\n{{repository_context}}\n</repository_context>\n\nConversation:\n<conversation>\n{{conversation}}\n</conversation>\n\nCurrent name: {{current_name}}",
  "nameConstraints": {
    "minLength": 3,
    "maxLength": 60
  }
}
```
<!-- pi-extension-settings:end -->

## Development

```sh
just setup
just coverage
```
