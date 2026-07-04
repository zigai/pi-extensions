# pi-codex-look

Compact Codex-style rendering for Pi tool calls and results.

## Configuration

Use global config at `~/.pi/agent/pi-codex-look/config.json`.

| Option                            | Default  | Purpose                                                                    |
| --------------------------------- | -------- | -------------------------------------------------------------------------- |
| `preserveTools`                   | `[]`     | Keep selected third-party tools on their original renderer.                |
| `syntax.preloadOnStartup`         | `false`  | Load Shiki during startup instead of lazily.                               |
| `toolLabels.dynamicStatus`        | `false`  | Use changing status labels like `Writing`/`Wrote` and `Editing`/`Edited`.  |
| `patches.assistantSeparator`      | `true`   | Add separators and spacing around assistant messages.                      |
| `patches.workingWidgetSpacing`    | `false`  | Remove one blank line near the working indicator with a global TUI patch.  |
| `patches.autocompleteCleanup`     | `true`   | Force a cleanup redraw after slash autocomplete closes.                    |
| `patches.markdownSyntax`          | `true`   | Add syntax highlighting to Markdown code fences.                           |
| `patches.thirdPartyToolRenderers` | `true`   | Apply compact renderers to compatible third-party tools.                   |
| `scriptPreview.headerLayout`      | `"auto"` | Choose script header placement: `auto`, `inline`, or `block`.              |
| `scriptPreview.formatters`        | `{}`     | Format script previews by sending code to the configured command on stdin. |

```json
{
  "$schema": "./config.schema.json",
  "preserveTools": [],
  "syntax": {
    "preloadOnStartup": false
  },
  "toolLabels": {
    "dynamicStatus": false
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

## Script Preview Layout

Script previews use adaptive headers by default. `auto` keeps short previews inline:

```text
• Python print('hi')
  │ print('bye')
```

When the first code line does not fit, non-Bash previews move code below the header:

```text
• Python
  │ root=Path.home()/'.pi/agent/debug-runs'
  │ rows=[]
```

Bash previews stay inline by default. Set `scriptPreview.headerLayout` to `"inline"` or `"block"` to force one layout globally.

## Script Preview Formatters

Script previews are not formatted by default. Configure `scriptPreview.formatters` to map rendered language ids to formatter command argv arrays. Formatter failures, missing commands, invalid JSON, and empty output are ignored; the original script preview is rendered unchanged.
