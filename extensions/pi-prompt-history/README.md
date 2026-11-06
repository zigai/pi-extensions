# Pi Prompt History

<a href="https://www.npmjs.com/package/@zigai/pi-prompt-history"><img alt="npm version" src="https://img.shields.io/npm/v/@zigai/pi-prompt-history.svg?color=blue" style="display:inline-block;border:0" /></a> <a href="https://www.npmjs.com/package/@zigai/pi-prompt-history"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@zigai/pi-prompt-history.svg" style="display:inline-block;border:0" /></a> <a href="https://github.com/zigai/pi-tweaks/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@zigai/pi-prompt-history.svg" style="display:inline-block;border:0" /></a>

Scoped prompt search and current-branch arrow recall for Pi's prompt editor.

## Install

```sh
pi install npm:@zigai/pi-prompt-history
```

## Features

- Restores user prompt history from the current session's active branch.
- Keeps prompt recall isolated from every other session, including sessions in the same project.
- Preserves Pi app-level editor keybindings while augmenting the editor history.

## Search

Press **Ctrl+R** or run **/prompt-history**. Each opening starts with an empty
query in **This project** by default. **Ctrl+S** cycles This session → This project
→ All projects without saving a preference. All query tokens must appear literally
(case-insensitive, any order); punctuation is not a regex.

Up/Down and PageUp/PageDown navigate. The multiline preview scrolls with
Ctrl+Up/Ctrl+Down. Enter or Tab copies the full prompt text into the editor;
**nothing is submitted or executed**. Escape/Ctrl+C cancels without touching the
draft or attachments. Recall is text-only: images are not reattached.

Project means the canonical Git worktree root, or canonical cwd outside Git.
Separate worktrees stay separate. Session search includes all saved branches;
arrow recall still includes only the active branch. Empty scopes never widen.
Loading, partial unreadable sessions, and unavailable storage are shown explicitly.

The generated global path below follows the configured Pi agent directory
(`PI_CODING_AGENT_DIR` overrides its location). Trusted project overrides use
`<project>/.pi/extension-settings/pi-prompt-history.json` with the host's configured
Pi directory name. Defaults < global < trusted project; invalid files are safely
reported and not rewritten. Example:

```json
{"defaultScope":"project"}
```

Set `defaultScope` to `session` or `global` for another default. Settings are loaded
at first search use and cached until new session/reload; every subsequent opening
uses that configured default, not the last temporary scope. `enabled: false`
disables modal search only, never existing arrow recall.

See [integration limits and verification](docs/implementation-notes.md) for storage
discovery, transformed/expanded user text, custom editor behavior, and check evidence.

## License

MIT

<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-prompt-history.json`.

| Option         | Type                               | Default     | Description                                                                      |
| -------------- | ---------------------------------- | ----------- | -------------------------------------------------------------------------------- |
| `enabled`      | boolean                            | `true`      | Enable modal prompt search (arrow recall stays available).                       |
| `defaultScope` | `session` \| `project` \| `global` | `"project"` | Scope used on each new picker opening; temporary scope cycling is not persisted. |

```json
{
  "$schema": "./schemas/pi-prompt-history.schema.json",
  "enabled": true,
  "defaultScope": "project"
}
```
<!-- pi-extension-settings:end -->
