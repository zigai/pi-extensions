# Pi Tweaks

A collection of small Pi extensions for improving interaction, display, and model selection.

## Install

Install individual extensions from the table below, or explicitly install the complete ordered collection:

```sh
pi install npm:@zigai/pi-tweaks
```

Do not enable the collection alongside the same individual extensions. The private repository root is a development package; the published collection references bundled, independently versioned dependencies through Pi resource paths. Personal migration settings retain their previous load order and enabled selection; installing the collection is an explicit opt-in to all 24 extensions.

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
| [pi-codex-goal](extensions/pi-goal)                                | Codex-style goal tracking and continuation for pi.                                | `pi install npm:pi-codex-goal`                 |
| [@zigai/pi-autoname-session](extensions/pi-autoname-session)       | Automatically name and keep Pi sessions organized                                 | `pi install npm:@zigai/pi-autoname-session`    |
| [@zigai/pi-toggles](extensions/pi-toggles)                         | Central capability policy, profiles, conditions, and session overrides for Pi     | `pi install npm:@zigai/pi-toggles`             |
| [@zigai/pi-settings-ui](extensions/pi-settings-ui)                 | Schema-driven TUI editor for Pi extension settings.                               | `pi install npm:@zigai/pi-settings-ui`         |
| [@zigai/pi-enhanced-skills](extensions/pi-expanded-skills)         | Enhanced Pi skills                                                                | `pi install npm:@zigai/pi-enhanced-skills`     |

## Libraries and collection

- [@zigai/pi-extension-internals](packages/pi-extension-internals): composition protocols and guarded Pi-internal loading.
- [@zigai/pi-extension-settings](packages/pi-extension-settings): settings runtime and artifact-generation CLI.
- [pi-typed-args](packages/pi-typed-args): typed command and skill arguments; its original repository was named pi-typed-commands.
- [@zigai/pi-tweaks](packages/pi-tweaks): ordered collection with exact independent extension-version pins.

## Development and verification

Use Node 24 and npm workspaces. `just setup` installs dependencies and pre-commit hooks, then runs `npm run check`. The root lockfile owns installation for `extensions/*` and `packages/*`; packages retain independent versions, exports, licenses, runtime dependencies, and strict verification contracts.

- `npm run build`: build settings/CLI first, then compiled workspace dependencies before consumers, then stage the collection's bundled dependencies from local tarballs.
- `npm run check`: build, check architecture/generated settings, run shared-root checks, verify every extension/library's independent installed dependency closure and the collection separately, then run all imported workspaces' complete `check` scripts in their own working directories.
- `npm test`, `npm run coverage`, `npm run typecheck`: build first, run the original shared suite and each imported package's own script with working-directory isolation. This retains PTY, platform, package smoke, and settings coverage-threshold checks.
- `npm run lint` / `npm run format:check`: check tracked and new nonignored files with repository-root configurations and tooling dependencies; scoped overrides retain package-specific policies. Workspace commands select that workspace's files.
- `npm run config:generate` / `npm run config:check`: build the local settings CLI, then generate or verify artifacts across workspace roots.
- `npm run test:package`: build and install independent consumers under `~/.cache/pi-tweaks/package-check/`, without Pi host peers, then probe the real Pi loader and RPC readiness. Temporary consumer runs are removed afterward; npm's normal cache remains reusable.

The collection stages dependency tarballs under `~/.cache/pi-tweaks/collection/` and installs bundled runtime dependencies in its ignored `node_modules/` directory. It uses Pi's supported `node_modules` manifest resource paths rather than a combined factory, preserving per-extension identity and settings. Root architecture validation checks collection order, pins, and resource paths against the development manifest.

Release tags identify individual package versions (for example `@zigai/pi-tree@0.6.1` or `pi-typed-args@0.1.1`). CI selects manifests by package name across both workspace roots and publishes missing exact-version prerequisites first. Publication is separate from migration. `npm run release` delegates to the machine's external `release` command; that command must support npm-workspace discovery.

## License

Original repository code is MIT. Imported and bundled packages retain their own license files and terms.
