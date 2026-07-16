# Configuration

The global configuration file is `~/.pi/agent/pi-codex-look/config.json`.

## Choosing a diff look

Start with the four layout settings below. The default colors are tuned for the bundled dark syntax
theme; set an individual color to `null` to derive it from the active Pi theme instead.

The default combines two ideas from [Hunk](https://github.com/modem-dev/hunk): a compact stack
gutter with separate old/new coordinates and a stronger word-diff shade inside a subtle row tint.

| Look                  | Background style | Line numbers | Narrow rows   | Wide layout     |
| --------------------- | ---------------- | ------------ | ------------- | --------------- |
| Hunk-inspired default | `two-tone`       | `dual`       | `paired`      | `content-aware` |
| Previous default      | `changed-spans`  | `single`     | `paired`      | `content-aware` |
| Traditional blocks    | `full-row`       | `dual`       | `traditional` | `fixed`         |

`two-tone` paints each changed row with a subtle red or green shade and paints Pierre's changed
word spans with a stronger shade. When a content shade is `null`, it is derived with a minimum
visual separation from the row shade. `changed-spans` leaves the row neutral and paints only changed spans.
`full-row` uses one semantic shade across the row.

`dual` uses aligned old and new columns in compact unified diffs. Deletions populate only the old
column, additions populate only the new column, and context rows show both coordinates. Split diffs
show the coordinate belonging to each pane before its change marker, matching Hunk's gutter order.
`single` restores the previous marker-first compact gutter.

## Options

### Diff appearance

| Option                                | Values/default                          | Purpose                                                        |
| ------------------------------------- | --------------------------------------- | -------------------------------------------------------------- |
| `appearance.diffBackgroundStyle`      | `two-tone`, `changed-spans`, `full-row` | Select row and intraline background treatment.                 |
| `appearance.diffLineNumberStyle`      | `dual`, `single`                        | Select the compact unified line-number gutter.                 |
| `appearance.narrowDiffLayout`         | `paired`, `traditional`                 | Pair similar replacements or group deletions before additions. |
| `appearance.sideBySideLayout`         | `content-aware`, `fixed`                | Select content-fit or fixed-width split eligibility.           |
| `appearance.addedRowBackground`       | `#213A2B`                               | Set the base addition shade; `null` derives it from Pi.        |
| `appearance.deletedRowBackground`     | `#4A221D`                               | Set the base deletion shade; `null` derives it from Pi.        |
| `appearance.addedContentBackground`   | `#0D5728`                               | Set the stronger added shade; `null` derives it.               |
| `appearance.deletedContentBackground` | `#762925`                               | Set the stronger deleted shade; `null` derives it.             |
| `appearance.dimUnchangedDiffText`     | `false`                                 | Dim unchanged text around changed spans.                       |
| `appearance.instructionPathColor`     | `null` or `#RRGGBB`                     | Override Skill and AGENTS path text.                           |

For compatibility with the previous appearance, `addedRowBackground` and
`deletedRowBackground` remain the only semantic backgrounds used by `changed-spans` and
`full-row`. The content-background overrides apply to `two-tone` only.

### Other settings

| Option                                    | Default                                                         | Purpose                                                         |
| ----------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| `preserveTools`                           | `[]`                                                            | Keep selected third-party tools on their original renderer.     |
| `debugLog.enabled`                        | `false`                                                         | Write bounded renderer and lifecycle diagnostics.               |
| `debugLog.path`                           | `"debug.log"`                                                   | Diagnostics path relative to the global config directory.       |
| `debugLog.maxBytes`                       | `null`                                                          | Rotate diagnostics after this size; `null` disables rotation.   |
| `debugLog.memorySampleIntervalMs`         | `10000`                                                         | Memory sampling interval; `0` disables sampling.                |
| `toolCallIndicator.symbol`                | `"•"`                                                           | Prefix shown before compact tool calls.                         |
| `toolCallIndicator.bold`                  | `true`                                                          | Render the tool-call indicator in bold.                         |
| `toolLabels.mode`                         | `"static"`                                                      | Use stable or lifecycle-aware tool labels.                      |
| `writePreview.movingViewport`             | `true`                                                          | Follow the newest rows while writes stream.                     |
| `syntax.preloadLanguages`                 | `["markdown","bash","python","typescript","javascript","json"]` | Languages available for synchronous highlighting.               |
| `syntax.bracketPairColoring`              | `true`                                                          | Color matching brackets; disable to use the syntax theme color. |
| `syntax.projectLanguageDetection.enabled` | `true`                                                          | Add languages inferred from project files.                      |
| `patches.assistantSeparator`              | `true`                                                          | Add spacing and separators around assistant messages.           |
| `patches.workingWidgetSpacing`            | `false`                                                         | Remove one blank line near the working indicator.               |
| `patches.autocompleteCleanup`             | `true`                                                          | Redraw after slash autocomplete closes.                         |
| `patches.markdownSyntax`                  | `true`                                                          | Highlight Markdown code fences.                                 |
| `patches.thirdPartyToolRenderers`         | `true`                                                          | Apply compact renderers to compatible third-party tools.        |
| `scriptPreview.headerLayout`              | `"auto"`                                                        | Choose `auto`, `inline`, or `block` script headers.             |
| `scriptPreview.maxCodePreviewLines`       | `8`                                                             | Collapsed script content rows before a separate omission row.   |
| `scriptPreview.formatters`                | `{}`                                                            | Commands that format script previews through stdin/stdout.      |

## Full default configuration

```json
{
  "$schema": "./config.schema.json",
  "preserveTools": [],
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
