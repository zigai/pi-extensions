# pi-glowup

High-signal rendering for Pi tool calls and results. Inspired by Codex CLI.

## Install

```sh
pi install npm:@zigai/pi-glowup
```

## Contents

- [Glowup tool rendering](docs/tool-rendering.md)
- [Configuration guide](docs/configuration.md)
- [Script previews](docs/script-previews.md)

## Configuration

Use global config at `~/.pi/agent/pi-glowup/config.json`.

| Option                                    | Default                                                         | Purpose                                                                     |
| ----------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `preserveTools`                           | `[]`                                                            | Keep selected third-party tools on their original renderer.                 |
| `mutations.defaultView`                   | `"full"`                                                        | Show every available completed-mutation row or a bounded `preview`.         |
| `mutations.previewLines`                  | `6`                                                             | Changed/content rows retained per file when using the preview view.         |
| `mutations.limits.maxDiffBytes`           | `524288`                                                        | Summarize larger diff snapshots; `null` disables the byte limit.            |
| `mutations.limits.maxDiffLines`           | `5000`                                                          | Summarize diffs with more rows; `null` disables the line limit.             |
| `mutations.limits.maxWritePreviewBytes`   | `65536`                                                         | Bound retained native-write content; `null` keeps all content.              |
| `mutations.limits.maxDeletePreimageBytes` | `262144`                                                        | Bound file contents captured before deletion; `null` disables the limit.    |
| `appearance.diffBackgroundStyle`          | `"two-tone"`                                                    | Use `two-tone`, `changed-spans`, or `full-row` diff backgrounds.            |
| `appearance.diffLineNumberStyle`          | `"dual"`                                                        | Show aligned `dual` old/new gutters or the previous `single` gutter.        |
| `appearance.narrowDiffLayout`             | `"paired"`                                                      | Pair similar old/new rows or use `traditional` block ordering.              |
| `appearance.sideBySideLayout`             | `"content-aware"`                                               | Use content-aware split selection or the `fixed` 140-column cutoff.         |
| `appearance.addedRowBackground`           | `"#213A2B"`                                                     | Set the subtle addition-row shade; `null` derives it from Pi.               |
| `appearance.deletedRowBackground`         | `"#4A221D"`                                                     | Set the subtle deletion-row shade; `null` derives it from Pi.               |
| `appearance.addedContentBackground`       | `"#0D5728"`                                                     | Set the stronger added intraline shade; `null` derives it.                  |
| `appearance.deletedContentBackground`     | `"#762925"`                                                     | Set the stronger deleted intraline shade; `null` derives it.                |
| `appearance.instructionPathColor`         | `null`                                                          | Override Skill/AGENTS path text with a `#RRGGBB` color; `null` uses Pi.     |
| `appearance.dimUnchangedDiffText`         | `false`                                                         | Dim unchanged text inside changed diff rows.                                |
| `debugLog.enabled`                        | `false`                                                         | Write JSONL diagnostics for memory, cache, renderer, and lifecycle state.   |
| `debugLog.path`                           | `"debug.log"`                                                   | File for diagnostics; relative paths resolve beside the global config.      |
| `debugLog.maxBytes`                       | `null`                                                          | Rotate the diagnostics file to `.1` after this size; `null` means no cap.   |
| `debugLog.memorySampleIntervalMs`         | `10000`                                                         | Sample memory while a session is active; use `0` to disable sampling.       |
| `toolCallIndicator.symbol`                | `"•"`                                                           | Text shown before every compact tool call.                                  |
| `toolCallIndicator.bold`                  | `true`                                                          | Render the tool-call indicator in bold across all call states.              |
| `toolLabels.mode`                         | `"static"`                                                      | Use `static` labels or `lifecycle` active/completed verb pairs.             |
| `writePreview.movingViewport`             | `true`                                                          | Follow the latest lines while a large write streams; disable for head-only. |
| `syntax.preloadLanguages`                 | `["markdown","bash","python","typescript","javascript","json"]` | Language ids or aliases to preload for synchronous syntax highlighting.     |
| `syntax.bracketPairColoring`              | `true`                                                          | Color matching brackets; disable to use the syntax theme's normal color.    |
| `syntax.projectLanguageDetection.enabled` | `true`                                                          | Add languages inferred from project filenames to the preload set.           |
| `patches.assistantSeparator`              | `true`                                                          | Add separators and spacing around assistant messages.                       |
| `patches.workingWidgetSpacing`            | `false`                                                         | Remove one blank line near the working indicator with a global TUI patch.   |
| `patches.autocompleteCleanup`             | `true`                                                          | Force a cleanup redraw after slash autocomplete closes.                     |
| `patches.markdownSyntax`                  | `true`                                                          | Add syntax highlighting to Markdown code fences.                            |
| `patches.thirdPartyToolRenderers`         | `true`                                                          | Apply compact renderers to compatible third-party tools.                    |
| `scriptPreview.headerLayout`              | `"auto"`                                                        | Choose script header placement: `auto`, `inline`, or `block`.               |
| `scriptPreview.maxCodePreviewLines`       | `8`                                                             | Maximum collapsed script content lines; omission rows are added separately. |
| `scriptPreview.formatters`                | `{}`                                                            | Format script previews by sending code to the configured command on stdin.  |

```json
{
  "$schema": "./config.schema.json",
  "preserveTools": [],
  "mutations": {
    "defaultView": "full",
    "previewLines": 6,
    "limits": {
      "maxDiffBytes": 524288,
      "maxDiffLines": 5000,
      "maxWritePreviewBytes": 65536,
      "maxDeletePreimageBytes": 262144
    }
  },
  "appearance": {
    "diffBackgroundStyle": "two-tone",
    "diffLineNumberStyle": "dual",
    "narrowDiffLayout": "paired",
    "sideBySideLayout": "content-aware",
    "addedRowBackground": "#213A2B",
    "deletedRowBackground": "#4A221D",
    "addedContentBackground": "#0D5728",
    "deletedContentBackground": "#762925",
    "instructionPathColor": null,
    "dimUnchangedDiffText": false
  },
  "debugLog": {
    "enabled": false,
    "path": "debug.log",
    "maxBytes": null,
    "memorySampleIntervalMs": 10000
  },
  "toolCallIndicator": {
    "symbol": "•",
    "bold": true
  },
  "toolLabels": {
    "mode": "static"
  },
  "writePreview": {
    "movingViewport": true
  },
  "syntax": {
    "preloadLanguages": ["markdown", "bash", "python", "typescript", "javascript", "json"],
    "bracketPairColoring": true,
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

## License

[MIT](LICENSE)
