# Pi Extensions

A collection of small Pi extensions for improving interaction, display, and model selection.

## Packages

| Package                                                            | What it does                                                                      | Install                                        |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------- |
| [@zigai/pi-footer](extensions/pi-footer)                           | A minimalistic, single-line replacement for Pi's footer.                          | `pi install npm:@zigai/pi-footer`              |
| [@zigai/pi-mention-anything](extensions/pi-mention-anything)       | Define arbitrary mention sources and triggers for Pi.                             | `pi install npm:@zigai/pi-mention-anything`    |
| [@zigai/pi-mention-skill](extensions/pi-mention-skill)             | Move Pi skill selection from slash autocomplete to `$` mentions.                  | `pi install npm:@zigai/pi-mention-skill`       |
| [@zigai/pi-mention-project](extensions/pi-mention-project)         | Adds fuzzy `#` mentions for configured Git project directories.                   | `pi install npm:@zigai/pi-mention-project`     |
| [@zigai/pi-response-renderer](extensions/pi-response-renderer)     | Compact assistant response rendering for Pi.                                      | `pi install npm:@zigai/pi-response-renderer`   |
| [@zigai/pi-model-alias](extensions/pi-model-alias)                 | Lets you alias long model IDs and provider display names.                         | `pi install npm:@zigai/pi-model-alias`         |
| [@zigai/pi-model-filter](extensions/pi-model-filter)               | Focused model lists for Pi, showing only the models you want.                     | `pi install npm:@zigai/pi-model-filter`        |
| [@zigai/pi-ui-tweaks](extensions/pi-ui-tweaks)                     | Small configurable UI tweaks for polishing Pi's interface.                        | `pi install npm:@zigai/pi-ui-tweaks`           |
| [@zigai/pi-keymap-tweaks](extensions/pi-keymap-tweaks)             | Opinionated editor and message-submit key tweaks for Pi.                          | `pi install npm:@zigai/pi-keymap-tweaks`       |
| [@zigai/pi-tree](extensions/pi-tree)                               | A cleaner, more informative `/tree` for Pi.                                       | `pi install npm:@zigai/pi-tree`                |
| [@zigai/pi-plain-user-messages](extensions/pi-plain-user-messages) | Plain-text rendering for user-submitted messages in Pi.                           | `pi install npm:@zigai/pi-plain-user-messages` |
| [@zigai/pi-message-highlights](extensions/pi-message-highlights)   | Highlights URLs and file paths in messages and the prompt editor.                 | `pi install npm:@zigai/pi-message-highlights`  |
| [@zigai/pi-status-bar](extensions/pi-status-bar)                   | Provides a programmable active and idle status bar with timing stats.             | `pi install npm:@zigai/pi-status-bar`          |
| [@zigai/pi-model-modes](extensions/pi-model-modes)                 | Mode presets for switching models and thinking levels in Pi.                      | `pi install npm:@zigai/pi-model-modes`         |
| [@zigai/pi-prompt-history](extensions/pi-prompt-history)           | Current-session prompt history for Pi's prompt editor.                            | `pi install npm:@zigai/pi-prompt-history`      |
| [@zigai/pi-trust-all-folders](extensions/pi-trust-all-folders)     | Automatically trust all folders in Pi.                                            | `pi install npm:@zigai/pi-trust-all-folders`   |
| [@zigai/pi-branch](extensions/pi-branch)                           | Pi package for branching the current session into parallel tmux or Ghostty panes. | `pi install npm:@zigai/pi-branch`              |
| [@zigai/pi-codex-core](extensions/pi-codex-core)                   | Everything GPT models need to feel at home in Pi.                                 | `pi install npm:@zigai/pi-codex-core`          |
| [@zigai/pi-glowup](extensions/pi-glowup)                           | Compact, high-signal rendering for Pi tool calls and results.                     | `pi install npm:@zigai/pi-glowup`              |
| [@zigai/pi-goal](extensions/pi-goal)                               | Codex-style goal tracking and continuation for pi.                                | `pi install npm:@zigai/pi-goal`                |
| [@zigai/pi-autoname-session](extensions/pi-autoname-session)       | Automatically name and keep Pi sessions organized                                 | `pi install npm:@zigai/pi-autoname-session`    |
| [@zigai/pi-toggles](extensions/pi-toggles)                         | Central capability policy, profiles, conditions, and session overrides for Pi     | `pi install npm:@zigai/pi-toggles`             |
| [@zigai/pi-settings-ui](extensions/pi-settings-ui)                 | Schema-driven TUI editor for Pi extension settings.                               | `pi install npm:@zigai/pi-settings-ui`         |
| [@zigai/pi-enhanced-skills](extensions/pi-expanded-skills)         | Enhanced Pi skills                                                                | `pi install npm:@zigai/pi-enhanced-skills`     |
| [@zigai/pi-lazy-mcp](extensions/pi-lazy-mcp)                       | Start MCP servers only when their tools are called.                               | `pi install npm:@zigai/pi-lazy-mcp`            |
| [@zigai/pi-workspace](extensions/pi-workspace)                     | Customize Pi's chat and sidebar; search saved history.                            | `pi install npm:@zigai/pi-workspace`           |

## Libraries

- [@zigai/pi-extension-internals](packages/pi-extension-internals): composition protocols and guarded Pi-internal loading.
- [@zigai/pi-extension-settings](packages/pi-extension-settings): settings runtime and artifact-generation CLI.
- [pi-typed-args](packages/pi-typed-args): typed command and skill arguments; its original repository was named pi-typed-commands.
- [@zigai/pi-tweaks](packages/pi-tweaks): ordered collection with exact independent extension-version pins.

## License

MIT
