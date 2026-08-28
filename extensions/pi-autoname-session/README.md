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
| `conversationScope` | `minimized` \| `full` | `"minimized"` | How much refresh context to send. Minimized sends only user and assistant text; full also includes tool arguments, results, and shell output. Initial naming always uses only the first user request. |
| `prompt` | string | *See JSON below* | Prompt used by the picker. Available placeholders are {{repository_context}}, {{conversation}}, {{current_name}}, {{cwd}}, and {{reason}}. |
| `nameConstraints.minLength` | integer | `6` | Minimum number of characters in a name returned by the picker. |
| `nameConstraints.maxLength` | integer | `40` | Maximum number of characters in a name returned by the picker. |

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
  "prompt": "Generate a title that will help the user recognize this coding session weeks later.\n\nBefore answering, silently identify:\n- Subject: the system, feature, or problem the request is really about.\n- Outcome: what the user ultimately wants to understand or change.\n- Incidental instructions: details about tools, process, output, or how the agent should work.\n\nTitle the durable subject and desired outcome. Discard incidental instructions.\nPrioritize user requests over assistant discoveries. Preserve the original subject until the user clearly changes goals.\n\nEditorial rules:\n- Use 3 to 8 words and a compact noun phrase or clear action phrase.\n- Capture the umbrella goal when the request lists several symptoms or steps.\n- Name the product change, not a plan, report, branch, commit, PR, test run, or monitoring step used to produce it.\n- Exclude models, subagents, tools, and output formats unless they are themselves the topic.\n- For reviews, name what is being reviewed and the relevant concern.\n- For research, name the question domain rather than the research process.\n- Do not claim the work is complete or merely copy and truncate the request.\n- Avoid repository names already visible in the workspace metadata, quotes, labels, filler, and trailing punctuation.\n\nWorkspace metadata:\n<workspace>\n{{repository_context}}\n</workspace>\n\nConversation:\n<conversation>\n{{conversation}}\n</conversation>\n\nCurrent title: {{current_name}}\nNaming phase: {{reason}}",
  "nameConstraints": {
    "minLength": 6,
    "maxLength": 40
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
