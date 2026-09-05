# Script Previews

Script previews use adaptive headers by default. Configure them with `scriptPreview` settings in `~/.pi/agent/extension-settings/pi-glowup.json`.

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

## Shell Layout

`scriptPreview.shellLayout` controls display-only reflow for composed Bash commands. The default,
`"auto"`, always structures compound forms such as loops, conditionals, functions, and case
statements; simpler one-line commands reflow only when their submitted form would wrap. Use
`"preserve"` to keep the submitted layout or `"always"` to reflow every safely parsed command.

Reflowed chain and case operators stay at the end of the preceding row by default. Set
`scriptPreview.shellOperatorPosition` to `"leading"` to place them at the start of the next row.

Reflow uses the Bash syntax tree to place logical operators, pipelines, statements, and compound
shell bodies on readable rows. It retains the original shell tokens, never extracts language
blocks from a composed command, and leaves submitted multiline commands and heredocs unchanged.
Only clean standalone interpreter calls render as Python, Node, TypeScript, Bun, or Deno previews.
Single-quoted inline source inside a composed command remains in the Bash block but receives its
language's syntax highlighting when the interpreter can be identified safely.

## Preview Length

Collapsed script previews show up to `scriptPreview.maxCodePreviewLines` lines before adding a
hint with Pi's configured tool-expansion key. The default is `8`, and values below `4` are rejected
so four-line-or-shorter previews are never truncated.

Short scripts keep their imports. Long Python, JavaScript, and TypeScript previews silently omit
only a complete leading import/setup prologue. Set `scriptPreview.showPrologueOmission` to `true`
to show the omitted-line count. Expanding the tool call always restores the complete code.

## Formatters

Script previews are not formatted by default. Configure `scriptPreview.formatters` to map rendered language ids to formatter command argv arrays.

Formatters apply only to clean standalone language calls. Composed Bash commands are never passed
to a language formatter. Successful formatter output is cached by language and source for the
session.

Formatter failures, missing commands, invalid JSON, and empty output are ignored; the original script preview is rendered unchanged.
