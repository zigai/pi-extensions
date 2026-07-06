# pi-codex-look

Compact Codex-style rendering for Pi tool calls and results.

## Contents

- [Codex-look tool rendering](docs/tool-rendering.md)
- [Script previews](docs/script-previews.md)

## Configuration

Use global config at `~/.pi/agent/pi-codex-look/config.json`.

| Option                                    | Default                        | Purpose                                                                    |
| ----------------------------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| `preserveTools`                           | `[]`                           | Keep selected third-party tools on their original renderer.                |
| `debugLog.enabled`                        | `true`                         | Write JSONL diagnostics for memory, cache, renderer, and lifecycle state.  |
| `debugLog.path`                           | `"debug.log"`                  | File for diagnostics; relative paths resolve beside the global config.     |
| `debugLog.maxBytes`                       | `null`                         | Rotate the diagnostics file to `.1` after this size; `null` means no cap.  |
| `debugLog.memorySampleIntervalMs`         | `10000`                        | Sample memory while a session is active; use `0` to disable sampling.      |
| `toolLabels.dynamicStatus`                | `false`                        | Use changing status labels like `Writing`/`Wrote` and `Editing`/`Edited`.  |
| `syntax.preloadLanguages`                 | `["markdown","bash","python"]` | Language ids or aliases to preload for synchronous Markdown highlighting.  |
| `syntax.projectLanguageDetection.enabled` | `true`                         | Add languages inferred from project filenames to the preload set.          |
| `patches.assistantSeparator`              | `true`                         | Add separators and spacing around assistant messages.                      |
| `patches.workingWidgetSpacing`            | `false`                        | Remove one blank line near the working indicator with a global TUI patch.  |
| `patches.autocompleteCleanup`             | `true`                         | Force a cleanup redraw after slash autocomplete closes.                    |
| `patches.markdownSyntax`                  | `true`                         | Add syntax highlighting to Markdown code fences.                           |
| `patches.thirdPartyToolRenderers`         | `true`                         | Apply compact renderers to compatible third-party tools.                   |
| `scriptPreview.headerLayout`              | `"auto"`                       | Choose script header placement: `auto`, `inline`, or `block`.              |
| `scriptPreview.formatters`                | `{}`                           | Format script previews by sending code to the configured command on stdin. |

```json
{
  "$schema": "./config.schema.json",
  "preserveTools": [],
  "debugLog": {
    "enabled": true,
    "path": "debug.log",
    "maxBytes": null,
    "memorySampleIntervalMs": 10000
  },
  "toolLabels": {
    "dynamicStatus": false
  },
  "syntax": {
    "preloadLanguages": ["markdown", "bash", "python"],
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
    "formatters": {}
  }
}
```

## Package Exports

- Extension entrypoint: `pi-codex-look`
- Passive rendering protocol types: `pi-codex-look/protocol`
