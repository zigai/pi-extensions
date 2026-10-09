# Pi Mention Skill

<a href="https://www.npmjs.com/package/@zigai/pi-mention-skill"><img alt="npm version" src="https://img.shields.io/npm/v/@zigai/pi-mention-skill.svg?color=blue" style="display:inline-block;border:0" /></a> <a href="https://www.npmjs.com/package/@zigai/pi-mention-skill"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@zigai/pi-mention-skill.svg" style="display:inline-block;border:0" /></a> <a href="https://github.com/zigai/pi-tweaks/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@zigai/pi-mention-skill.svg" style="display:inline-block;border:0" /></a>

Move Pi skill selection from slash autocomplete to `$` mentions.

## Install

```sh
pi install npm:@zigai/pi-mention-skill
```

## Features

- Adds fuzzy skill autocomplete with `$` mentions.
- Ranks initial suggestions by frecency, recency, frequency, name, or command order.
- Supports custom triggers, pinned skills, and optional project-local priority.
- Expands mentions such as `$skill-name` before the model sees the prompt.
- Keeps `/skill:*` entries out of slash autocomplete by default.

## Usage

Type `$` in the prompt editor to open skill suggestions, then select a skill.

The selected mention loads the same skill content that `/skill:name` would have loaded, while keeping skills out of the normal slash command picker.

History-based ordering records autocomplete selections in `~/.pi/agent/state/pi-mention-skill-selections.json`. Frecency combines selection count with recency; manually typed mentions do not update this history.

<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-mention-skill.json`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `trigger` | string | `"$"` | One or more non-whitespace, non-slash characters that start a skill mention. |
| `hideSlashSkills` | boolean | `true` | Hide skill commands from slash-command completion. |
| `completionSuffix` | string | `" "` | Text inserted after a completed skill mention. |
| `initialSuggestions.strategy` | `frecency` \| `recent` \| `frequent` \| `alphabetical` \| `sourceOrder` | `"frecency"` | Ordering used before any skill query text is entered. |
| `initialSuggestions.pinned` | string[] | `[]` | Skill names placed first, in this order, before the configured strategy. |
| `initialSuggestions.projectSkillsFirst` | boolean | `false` | Place project-local skills before user and temporary skills in initial suggestions. |

```json
{
  "$schema": "./schemas/pi-mention-skill.schema.json",
  "trigger": "$",
  "hideSlashSkills": true,
  "completionSuffix": " ",
  "initialSuggestions": {
    "strategy": "frecency",
    "pinned": [],
    "projectSkillsFirst": false
  }
}
```
<!-- pi-extension-settings:end -->

## License

MIT
