# Pi Toggles

Pi Toggles is a central control panel for Pi capabilities. It lets you temporarily or persistently change which tools are active, group policy into profiles, activate policy from typed conditions, and inspect why each capability has its effective state.

- Search and inspect tools, skills, and extension slash commands with source provenance.
- Turn tools on, off, or lazy for the current session, globally, or in a trusted project.
- Control skill model visibility and `/skill:name` invocation independently with `on`, `off`, `name-only`, and `user-only`.
- Block stale calls to disabled tools, not merely hide their definitions from the model.
- Add conditional system-prompt fragments and publish custom condition values from companion extensions.
- See explicit diagnostics for resource controls that Pi's public extension API cannot yet enforce.

## Install

```sh
pi install npm:@zigai/pi-toggles
```

## Use

Open the interactive panel:

```text
/toggles
```

The panel stages changes until you press `Ctrl+S`. Session scope is temporary and survives reload or resuming the same saved session. Global and trusted-project changes are stored in Pi Toggles settings.

Commands are also available for direct use:

```text
/toggles list tool
/toggles set write off --scope session
/toggles set github_search lazy --scope project
/toggles profile review --scope session
/toggles explain write
/toggles doctor
```

Tool states are `inherit`, `on`, `off`, and `lazy`. Lazy tools stay out of the initial model context and can be activated through the policy-aware `search_capabilities` tool. Skill states additionally support `name-only` and `user-only`; `off` removes the skill from model metadata and blocks explicit `/skill:name` expansion. Pi's read-only command autocomplete may still list that loaded skill, but selecting it cannot bypass the gate.

<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-toggles.json`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Enforce Pi Toggles policy while preserving the recovery command. |
| `defaults.unknownCondition` | `no-match` | `"no-match"` | Treat unknown or failed condition facts as a non-match. |
| `defaults.lazyToolLimit` | integer | `5` | Maximum tools activated by one lazy capability search. |
| `defaults.showStatus` | boolean | `true` | Show a compact footer status when policy changes Pi or has diagnostics. |
| `activeProfile` | string | — | Persistent profile selected at this settings scope. |
| `overrides` | object[] | `[]` | Explicit persistent capability decisions. |
| `profiles` | object | `{}` | Named bundles of capability decisions and prompt fragments. |
| `promptFragments` | object[] | `[]` | Owned system-prompt fragments available to profiles and conditions. |
| `rules` | object[] | `[]` | Conditional decisions and profile activations. |

```json
{
  "$schema": "./schemas/pi-toggles.schema.json",
  "enabled": true,
  "defaults": {
    "unknownCondition": "no-match",
    "lazyToolLimit": 5,
    "showStatus": true
  },
  "overrides": [],
  "profiles": {},
  "promptFragments": [],
  "rules": []
}
```
<!-- pi-extension-settings:end -->

Trusted-project settings use `.pi/extension-settings/pi-toggles.json`. Project policy is ignored until Pi trusts the project.

Profiles bundle decisions and prompt fragments. Rules activate decisions or profiles from declarative facts such as the run mode, current model, prompt text, Git branch, trusted project files, or extension-published context keys. Conditions never evaluate JavaScript or shell commands from JSON.

Rules based on frequently changing facts such as `prompt.text` or `project.gitDirty`, tool removals, and prompt fragments can reduce model prompt-cache reuse.

For example, this profile removes mutation tools and adds guidance whenever the prompt contains `review`:

```json
{
  "profiles": {
    "review": {
      "decisions": [
        {
          "target": { "kind": "tool", "source": "builtin", "name": "write" },
          "state": "off"
        },
        {
          "target": { "kind": "tool", "source": "builtin", "name": "edit" },
          "state": "off"
        }
      ],
      "promptFragments": ["review-guidance"]
    }
  },
  "promptFragments": [
    {
      "id": "review-guidance",
      "content": { "kind": "inline", "text": "Review without modifying files." },
      "priority": 100
    }
  ],
  "rules": [
    {
      "id": "review-request",
      "priority": 100,
      "when": { "fact": "prompt.text", "contains": "review" },
      "decisions": [],
      "activateProfiles": ["review"]
    }
  ]
}
```

Companion extensions can register and update typed facts through `pi.events` using `pi-toggles:register-context-key`, `pi-toggles:set-context`, and `pi-toggles:clear-context`. Pi Toggles emits `pi-toggles:context-ready` after each session starts so registration does not depend on extension load order.

## Current Pi API limits

Pi Toggles controls loaded skills through Pi's public `systemPromptOptions.skills`, `formatSkillsForPrompt()`, and pre-expansion `input` event. Extension slash commands still run before that event, so Pi Toggles reports them as unsupported instead of presenting a cosmetic toggle as enforcement. Built-in slash commands are outside the current scope. Prompt templates and extension loading are deliberately not Pi Toggles capabilities.

See the [proposed Pi resource-control API](docs/upstream-pi-api.md) for the exact upstream contracts needed to remove these limitations.

## Development

```sh
just setup
just coverage
```

## License

[MIT](LICENSE)
