# pi-glowup

[![CI](https://github.com/zigai/pi-glowup/actions/workflows/ci.yml/badge.svg)](https://github.com/zigai/pi-glowup/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@zigai/pi-glowup?color=blue)](https://www.npmjs.com/package/@zigai/pi-glowup)
[![npm downloads](https://img.shields.io/npm/dm/@zigai/pi-glowup?color=blue)](https://www.npmjs.com/package/@zigai/pi-glowup)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`pi-glowup` provides compact, high-signal terminal UI rendering for [Pi](https://github.com/earendil-works/pi) tool calls and results. Inspired by Codex CLI, it formats file edits, writes, Bash executions, script previews, and tool outputs into readable, syntax-highlighted terminal components.

## Install

```sh
pi install npm:@zigai/pi-glowup
```

## Usage

Once installed, `pi-glowup` automatically formats native Pi tool calls and compatible extension tools:

- **File mutations:** Renders unified or side-by-side diffs for file edits, writes, and deletions with syntax highlighting and line numbers.
- **Script previews:** Reflows composed Bash commands and presents multiline Python, Node, and shell scripts.
- **Tool integration:** Compactly displays third-party tool executions through generic and custom protocol adapters.

## Documentation

- [Tool rendering](docs/tool-rendering.md): Protocol contract, custom tool adapters, and rendering selection rules.
- [Configuration](docs/configuration.md): Visual diff styles, mutation line budgets, and appearance settings.
- [Script previews](docs/script-previews.md): Adaptive Bash command reflowing, script header layouts, and code formatters.
- [Architecture](docs/architecture.md): Internal code organization, dependency boundaries, and extension lifecycle.

<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-glowup.json`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `preserveTools` | string[] | `[]` | Keep selected third-party tools on their original renderer. |
| `mutations.defaultView` | `full` \| `preview` | `"full"` | Show every available completed-mutation row or a bounded semantic preview. |
| `mutations.previewLines` | integer | `6` | Changed/content rows retained per file in preview view. |
| `mutations.limits.maxDiffBytes` | integer \| null | `524288` | Maximum combined diff snapshot or metadata bytes; null disables this limit. |
| `mutations.limits.maxDiffLines` | integer \| null | `5000` | Maximum diff rows before rendering a summary; null disables this limit. |
| `mutations.limits.maxWritePreviewBytes` | integer \| null | `65536` | Maximum native-write content bytes retained for rendering; null disables this limit. |
| `mutations.limits.maxDeletePreimageBytes` | integer \| null | `262144` | Maximum file bytes captured before deletion; null disables this limit. |
| `appearance.diffBackgroundStyle` | `changed-spans` \| `two-tone` \| `full-row` | `"two-tone"` | Background treatment for changed diff rows and intraline spans. |
| `appearance.diffLineNumberStyle` | `single` \| `dual` | `"dual"` | Show one relevant line number or aligned old and new line-number columns. |
| `appearance.narrowDiffLayout` | `paired` \| `traditional` | `"paired"` | Order similar deletion/addition rows together or in traditional blocks. |
| `appearance.sideBySideLayout` | `content-aware` \| `fixed` | `"content-aware"` | Choose split diffs from content fit or a fixed terminal-width threshold. |
| `appearance.addedRowBackground` | string \| null | `"#213A2B"` | Subtle addition-row background; null derives it from the active Pi theme. |
| `appearance.deletedRowBackground` | string \| null | `"#4A221D"` | Subtle deletion-row background; null derives it from the active Pi theme. |
| `appearance.addedContentBackground` | string \| null | `"#0D5728"` | Stronger added intraline-span background; null derives a contrasting shade. |
| `appearance.deletedContentBackground` | string \| null | `"#762925"` | Stronger deleted intraline-span background; null derives a contrasting shade. |
| `appearance.instructionPathColor` | string \| null | `null` | Instruction-file path foreground; null inherits the active Pi theme. |
| `appearance.dimUnchangedDiffText` | boolean | `false` | Dim unchanged text around changed intraline spans. |
| `debugLog.enabled` | boolean | `false` | Write bounded renderer and lifecycle diagnostics. |
| `debugLog.path` | string | `"debug.log"` | Diagnostics path relative to the pi-glowup data directory unless absolute. |
| `debugLog.maxBytes` | integer \| null | `null` | Rotate diagnostics after this size; null disables rotation. |
| `debugLog.memorySampleIntervalMs` | integer | `10000` | Memory sampling interval; 0 disables sampling. |
| `renderCache.maxBytes` | integer | `67108864` | Maximum bytes retained for completed rendered tool output. |
| `renderCache.maxEntries` | integer | `10000` | Maximum completed tool components retained in the render cache. |
| `toolCallIndicator.symbol` | string | `"•"` | Prefix shown before compact tool calls. |
| `toolCallIndicator.bold` | boolean | `true` | Render the tool-call indicator in bold. |
| `toolLabels.mode` | `static` \| `lifecycle` | `"static"` | Use stable or lifecycle-aware tool labels. |
| `writePreview.movingViewport` | boolean | `true` | Follow the newest rows while writes stream. |
| `syntax.preloadLanguages` | string[] | *See JSON below* | Language ids or aliases to preload for synchronous syntax highlighting. |
| `syntax.bracketPairColoring` | boolean | `true` | Color matching bracket pairs; false preserves the syntax theme color. |
| `syntax.projectLanguageDetection.enabled` | boolean | `true` | Add languages inferred from project filenames to the preload set. |
| `patches.assistantSeparator` | boolean | `true` | Add spacing and separators around assistant messages. |
| `patches.workingWidgetSpacing` | boolean | `false` | Remove one blank line near the working indicator. |
| `patches.autocompleteCleanup` | boolean | `true` | Redraw after slash autocomplete closes. |
| `patches.markdownSyntax` | boolean | `true` | Highlight Markdown code fences. |
| `patches.thirdPartyToolRenderers` | boolean | `true` | Apply compact renderers to compatible third-party tools. |
| `scriptPreview.headerLayout` | `auto` \| `inline` \| `block` | `"auto"` | Choose auto, inline, or block script headers. |
| `scriptPreview.maxCodePreviewLines` | integer | `8` | Collapsed script content rows before a separate omission row. |
| `scriptPreview.showPrologueOmission` | boolean | `false` | Show a count row when collapsed previews omit leading setup imports. |
| `scriptPreview.shellLayout` | `preserve` \| `auto` \| `always` | `"auto"` | Choose when composed Bash commands are reflowed at safe syntax boundaries. |
| `scriptPreview.shellOperatorPosition` | `trailing` \| `leading` | `"trailing"` | Place Bash chain operators before or after reflowed line breaks. |
| `scriptPreview.formatters` | Record<string, string[]> | `{}` | Commands that format script previews through stdin/stdout. |

```json
{
  "$schema": "./schemas/pi-glowup.schema.json",
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
  "syntax": {
    "preloadLanguages": [
      "markdown",
      "bash",
      "python",
      "typescript",
      "javascript",
      "json"
    ],
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
    "showPrologueOmission": false,
    "shellLayout": "auto",
    "shellOperatorPosition": "trailing",
    "formatters": {}
  }
}
```
<!-- pi-extension-settings:end -->

## License

[MIT](LICENSE)
