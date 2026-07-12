# pi-codex-look

Compact Codex-style rendering for Pi tool calls and results.

## Contents

- [Codex-look tool rendering](docs/tool-rendering.md)
- [Script previews](docs/script-previews.md)

## Configuration

Use global config at `~/.pi/agent/pi-codex-look/config.json`.

| Option                                    | Default                                                         | Purpose                                                                     |
| ----------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `preserveTools`                           | `[]`                                                            | Keep selected third-party tools on their original renderer.                 |
| `appearance.diffBackgroundStyle`          | `"changed-spans"`                                               | Highlight `changed-spans` only or paint each `full-row`.                    |
| `appearance.narrowDiffLayout`             | `"paired"`                                                      | Pair similar old/new rows or use `traditional` block ordering.              |
| `appearance.sideBySideLayout`             | `"content-aware"`                                               | Use content-aware split selection or the `fixed` 140-column cutoff.         |
| `appearance.addedRowBackground`           | `null`                                                          | Override addition backgrounds with a `#RRGGBB` color; `null` uses Pi.       |
| `appearance.deletedRowBackground`         | `null`                                                          | Override deletion backgrounds with a `#RRGGBB` color; `null` uses Pi.       |
| `appearance.instructionPathColor`         | `null`                                                          | Override Skill/AGENTS path text with a `#RRGGBB` color; `null` uses Pi.     |
| `debugLog.enabled`                        | `false`                                                         | Write JSONL diagnostics for memory, cache, renderer, and lifecycle state.   |
| `debugLog.path`                           | `"debug.log"`                                                   | File for diagnostics; relative paths resolve beside the global config.      |
| `debugLog.maxBytes`                       | `null`                                                          | Rotate the diagnostics file to `.1` after this size; `null` means no cap.   |
| `debugLog.memorySampleIntervalMs`         | `10000`                                                         | Sample memory while a session is active; use `0` to disable sampling.       |
| `toolLabels.mode`                         | `"static"`                                                      | Use `static` labels or `lifecycle` active/completed verb pairs.             |
| `writePreview.movingViewport`             | `true`                                                          | Follow the latest lines while a large write streams; disable for head-only. |
| `syntax.preloadLanguages`                 | `["markdown","bash","python","typescript","javascript","json"]` | Language ids or aliases to preload for synchronous syntax highlighting.     |
| `syntax.projectLanguageDetection.enabled` | `true`                                                          | Add languages inferred from project filenames to the preload set.           |
| `patches.assistantSeparator`              | `true`                                                          | Add separators and spacing around assistant messages.                       |
| `patches.workingWidgetSpacing`            | `false`                                                         | Remove one blank line near the working indicator with a global TUI patch.   |
| `patches.autocompleteCleanup`             | `true`                                                          | Force a cleanup redraw after slash autocomplete closes.                     |
| `patches.markdownSyntax`                  | `true`                                                          | Add syntax highlighting to Markdown code fences.                            |
| `patches.thirdPartyToolRenderers`         | `true`                                                          | Apply compact renderers to compatible third-party tools.                    |
| `scriptPreview.headerLayout`              | `"auto"`                                                        | Choose script header placement: `auto`, `inline`, or `block`.               |
| `scriptPreview.maxCodePreviewLines`       | `8`                                                             | Maximum collapsed script preview lines before truncation; minimum is `4`.   |
| `scriptPreview.formatters`                | `{}`                                                            | Format script previews by sending code to the configured command on stdin.  |

```json
{
  "$schema": "./config.schema.json",
  "preserveTools": [],
  "appearance": {
    "diffBackgroundStyle": "changed-spans",
    "narrowDiffLayout": "paired",
    "sideBySideLayout": "content-aware",
    "addedRowBackground": null,
    "deletedRowBackground": null,
    "instructionPathColor": null
  },
  "debugLog": {
    "enabled": false,
    "path": "debug.log",
    "maxBytes": null,
    "memorySampleIntervalMs": 10000
  },
  "toolLabels": {
    "mode": "static"
  },
  "writePreview": {
    "movingViewport": true
  },
  "syntax": {
    "preloadLanguages": ["markdown", "bash", "python", "typescript", "javascript", "json"],
    "projectLanguageDetection": {
      "enabled": true
    }
  },
  "patches": {
    "assistantSeparator": true,
    "workingWidgetSpacing": false,
    "autocompleteCleanup": true,
    "markdownSyntax": true,
    "thirdPartyToolRenderers": true
  },
  "scriptPreview": {
    "headerLayout": "auto",
    "maxCodePreviewLines": 8,
    "formatters": {}
  }
}
```

## Package Exports

- Extension entrypoint: `pi-codex-look`
- Passive rendering protocol types: `pi-codex-look/protocol`
