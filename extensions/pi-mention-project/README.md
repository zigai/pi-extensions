# Pi Mention Project

<a href="https://www.npmjs.com/package/@zigai/pi-mention-project"><img alt="npm version" src="https://img.shields.io/npm/v/@zigai/pi-mention-project.svg?color=blue" style="display:inline-block;border:0" /></a> <a href="https://www.npmjs.com/package/@zigai/pi-mention-project"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@zigai/pi-mention-project.svg" style="display:inline-block;border:0" /></a> <a href="https://github.com/zigai/pi-tweaks/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@zigai/pi-mention-project.svg" style="display:inline-block;border:0" /></a>

Reference configured projects with `#` mentions.

## Install

```sh
pi install npm:@zigai/pi-mention-project
```

## Features

- Adds fuzzy project autocomplete with `#` mentions.
- Ranks initial suggestions by frecency, recency, frequency, name, or discovery order.
- Supports custom single- or multi-character triggers and pinned projects.
- Expands selected mentions to absolute project paths when prompts are submitted.
- Searches one or more configured folders for projects.

## Usage

Type `#` in the prompt editor to open project suggestions, then select a project.

The selected mention expands to the project's absolute path in both the displayed message and model context.

History-based ordering records autocomplete selections in `~/.pi/agent/state/pi-mention-project-selections.json`. Frecency combines selection count with recency; manually typed mentions do not update this history.

<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-mention-project.json`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `trigger` | string | `"#"` | One or more non-whitespace, non-slash characters that start a project mention. |
| `roots` | string \| string[] | `[]` | Project root directory or directories searched for projects. |
| `gitReposOnly` | boolean | `true` | Include only directories containing Git repositories. |
| `includeDotFolders` | boolean | `false` | Include project directories whose names start with a dot. |
| `completionSuffix` | string | `" "` | Text inserted after a completed project mention. |
| `initialSuggestions.strategy` | `frecency` \| `recent` \| `frequent` \| `alphabetical` \| `sourceOrder` | `"frecency"` | Ordering used before any project query text is entered. |
| `initialSuggestions.pinned` | string[] | `[]` | Project names placed first, in this order, before the configured strategy. |

```json
{
  "$schema": "./schemas/pi-mention-project.schema.json",
  "trigger": "#",
  "roots": [],
  "gitReposOnly": true,
  "includeDotFolders": false,
  "completionSuffix": " ",
  "initialSuggestions": {
    "strategy": "frecency",
    "pinned": []
  }
}
```
<!-- pi-extension-settings:end -->

## License

MIT
