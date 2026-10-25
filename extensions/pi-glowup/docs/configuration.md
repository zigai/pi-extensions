# Configuration

The global configuration file is `~/.pi/agent/extension-settings/pi-glowup.json`.

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

### Mutation rendering

Completed writes, edits, deletes, and compatible patch tools use the same mutation policy. The
default `full` view renders every available diff row. Pierre-backed native edits and completed
`apply_patch` calls also use the existing width policy to select a unified or side-by-side layout.
The default `content-aware` policy uses split layout only when every source row fits one physical
row in both panes; otherwise it falls back to unified. The explicit `fixed` policy keeps the legacy
width threshold and may wrap pane content.
Use `preview` to restore the bounded six-row view with an expansion hint. Active streaming previews
remain bounded while arguments are still arriving.

Limits apply before rendering and protect session responsiveness. A `null` limit disables that
specific guardrail.

| Option                                    | Default  | Purpose                                                |
| ----------------------------------------- | -------- | ------------------------------------------------------ |
| `mutations.defaultView`                   | `full`   | Use `full` completed diffs or bounded `preview` diffs. |
| `mutations.previewLines`                  | `6`      | Rows retained per file in the preview view.            |
| `mutations.limits.maxDiffBytes`           | `524288` | Maximum combined diff snapshot bytes.                  |
| `mutations.limits.maxDiffLines`           | `5000`   | Maximum rows before a diff becomes a summary.          |
| `mutations.limits.maxWritePreviewBytes`   | `65536`  | Maximum native-write content retained for rendering.   |
| `mutations.limits.maxDeletePreimageBytes` | `262144` | Maximum readable file size captured before deletion.   |

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

| Option                                    | Default          | Purpose                                                         |
| ----------------------------------------- | ---------------- | --------------------------------------------------------------- |
| `preserveTools`                           | `[]`             | Keep selected third-party tools on their original renderer.     |
| `debugLog.enabled`                        | `false`          | Write bounded renderer and lifecycle diagnostics.               |
| `debugLog.path`                           | `"debug.log"`    | Diagnostics path relative to the pi-glowup data directory.      |
| `debugLog.maxBytes`                       | `null`           | Rotate diagnostics after this size; `null` disables rotation.   |
| `debugLog.memorySampleIntervalMs`         | `10000`          | Memory sampling interval; `0` disables sampling.                |
| `renderCache.maxBytes`                    | `67108864`       | Maximum bytes retained for completed rendered tool output.      |
| `renderCache.maxEntries`                  | `10000`          | Maximum completed tool components retained in the cache.        |
| `toolCallIndicator.symbol`                | `"•"`            | Prefix shown before compact tool calls.                         |
| `toolCallIndicator.bold`                  | `true`           | Render the tool-call indicator in bold.                         |
| `toolLabels.mode`                         | `"static"`       | Use stable or lifecycle-aware tool labels.                      |
| `writePreview.movingViewport`             | `true`           | Follow the newest rows while writes stream.                     |
| `syntax.preloadLanguages`                 | _See JSON below_ | Languages available for synchronous highlighting.               |
| `syntax.bracketPairColoring`              | `true`           | Color matching brackets; disable to use the syntax theme color. |
| `syntax.projectLanguageDetection.enabled` | `true`           | Add languages inferred from project files.                      |
| `patches.assistantSeparator`              | `true`           | Add spacing and separators around assistant messages.           |
| `patches.workingWidgetSpacing`            | `false`          | Remove one blank line near the working indicator.               |
| `patches.autocompleteCleanup`             | `true`           | Redraw after slash autocomplete closes.                         |
| `patches.markdownSyntax`                  | `true`           | Highlight Markdown code fences.                                 |
| `patches.thirdPartyToolRenderers`         | `true`           | Apply compact renderers to compatible third-party tools.        |
| `scriptPreview.maxCodePreviewLines`       | `8`              | Collapsed script content rows before a separate omission row.   |
| `scriptPreview.showPrologueOmission`      | `false`          | Show a count row for omitted leading setup imports.             |
| `scriptPreview.shellLayout`               | `"auto"`         | Choose when composed Bash commands are safely reflowed.         |
| `scriptPreview.shellOperatorPosition`     | `"trailing"`     | Place Bash chain operators before or after reflowed breaks.     |
| `scriptPreview.shellOutputStyle`          | `"terminal"`     | Show Bash output flush left, or behind a dim `│` gutter.        |
| `scriptPreview.formatters`                | `{}`             | Commands that format script previews through stdin/stdout.      |

### Render diagnostics

While `debugLog.enabled` is `true`, the JSONL log also records how Glowup rendered code.
The log may contain formatter stderr, so keep it private. `codeHash` is the first 16 hex
characters of the SHA-256 of the exact code text, so the same code can be matched across
events. Offsets are UTF-16 indices into the original command.

- `script_analysis`: one per completed `bash` or `codemode` call: the standalone or shell
  path, plus each extracted heredoc or inline program, including awk and jq programs, with
  its offsets, whether it was sent to the formatter, and why not (`skipReason`, for example
  `fits-width`, `double-quoted`, `comment`, `defs`, or `heredoc-present`). `displayHash`
  is the shown text when formatting changed it.
- `script_format`: one per formatter call, with `stage`, `outcome`, timing, exit status,
  and the start of stderr. `outputHash` matches the highlighted text when the output is shown.
  `detail` names the rule that kept a `declined` program. Statement, block, and embedded
  calls carry their `toolCallId`; once the source is complete, `segmentHash` is the
  `codeHash` of the analysed segment (or the `commandHash` of a shell command) they belong to.
- `syntax_highlight`: one per code, language, and outcome per session (`highlighted`,
  `cached`, `unsupported-language`, `unavailable`, `over-budget`, `failed`, `cancelled`,
  `backpressure`).
- `render_error`: an exception Glowup caught and ignored while rendering, formatting, or
  highlighting.

## Full default configuration

```json
{
  "$schema": "./schemas/pi-glowup.schema.json",
  "preserveTools": [],
  "presentation": "compact",
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
  "renderCache": {
    "maxBytes": 67108864,
    "maxEntries": 10000
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
  "streaming": {
    "prose": "token",
    "code": "token"
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
    "maxCodePreviewLines": 8,
    "showPrologueOmission": false,
    "shellLayout": "auto",
    "shellOperatorPosition": "trailing",
    "shellOutputStyle": "terminal",
    "formatters": {}
  }
}
```
