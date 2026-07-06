# Script Previews

Script previews use adaptive headers by default. Configure them with `scriptPreview` settings in `config.json`.

## Header Layout

`auto` keeps short previews inline:

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

## Formatters

Script previews are not formatted by default. Configure `scriptPreview.formatters` to map rendered language ids to formatter command argv arrays.

Formatter failures, missing commands, invalid JSON, and empty output are ignored; the original script preview is rendered unchanged.
