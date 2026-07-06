# Script Previews

Script previews use adaptive headers by default. Configure them with `scriptPreview` settings in `config.json`.

## Header Layout

`auto` keeps single-line previews inline:

```text
• Bash sleep 300
```

Multiline previews move code below the header for every language:

```text
• Python
  │ print('hi')
  │ print('bye')
```

Set `scriptPreview.headerLayout` to `"inline"` or `"block"` to force one layout globally.

## Preview Length

Collapsed script previews show up to `scriptPreview.maxCodePreviewLines` lines before adding a truncation hint. The default is `8`, and values below `4` are rejected so four-line-or-shorter previews are never truncated.

## Formatters

Script previews are not formatted by default. Configure `scriptPreview.formatters` to map rendered language ids to formatter command argv arrays.

Formatter failures, missing commands, invalid JSON, and empty output are ignored; the original script preview is rendered unchanged.
