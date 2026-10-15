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
blocks from a composed command, and preserves existing newlines, quoted text, and heredoc bodies.
Only clean standalone interpreter calls render as Python, Node, TypeScript, Bun, or Deno previews.
Single-quoted inline source inside a composed command remains in the Bash block but receives its
language's syntax highlighting when the interpreter can be identified safely.

## Preview Length

Collapsed script previews show up to `scriptPreview.maxCodePreviewLines` lines before adding a
hint with Pi's configured tool-expansion key. The default is `8`, and values below `4` are rejected
while wrapping also counts against the terminal-row budget.

Unformatted short scripts keep their imports. Long Python, JavaScript, and TypeScript previews omit
only a complete leading import/setup prologue. Set `scriptPreview.showPrologueOmission` to `true`
to show the omitted-line count. Expanding the tool call always restores the complete code.

## Formatters

Formatting is off by default. `scriptPreview.formatters` maps language ids to explicit profiles:

```json
{
  "javascript": { "kind": "javascript", "command": ["oxfmt"], "objectWrap": "collapse" },
  "typescript": { "kind": "typescript", "command": ["oxfmt"], "tabWidth": 2 },
  "python": { "kind": "python", "command": ["tuff"], "collections": "ruff-default" },
  "bash": { "kind": "bash", "command": ["shfmt"], "indentWidth": 2 }
}
```

Python collapses collections that fit, ignores magic trailing commas by default, and retains
comments and literal contents. Explicit `collections: "fill"` keeps multiline brackets and packs rows. JavaScript/TypeScript use Oxfmt object collapse and two-space
indentation. Bash uses two-space shfmt without simplification or minification; only a Bash profile
formats whole shell commands. Executables must already be installed and reachable, or use an
explicit executable path. `kind: "command"` accepts arbitrary formatter argv through `command`.

Profiles format asynchronously at the available content width and after resize. Oxfmt receives
`printWidth` through an owned temporary configuration; Tuff receives line length and an isolated
collection profile. Blank-line decisions belong to the formatter, never a text-stripping pass.
Python/JS/TS profiles omit complete leading imports by default; `imports: "show"` retains them.
Bash keeps setup statements and heredocs. Expanded Bash-tool and Codemode previews show original source.

Streaming previews keep raw source until execution completes. Prepared decoration is then
published in one update, or once ready if the result arrives first. Formatting never delays tool
execution or changes submitted arguments. Successful output is cached by language, width, and
source. Command profiles also accept `{width}`, `{line_length}`, and `{cols}` argv placeholders.
Missing or failed executables produce a content-free warning; undecorated source remains visible.

## Highlighting

Code within the 40 KiB source budget is tokenized off the TUI thread without a logical-line cutoff.
Plain source remains visible while full grammar-aware colors are pending. Superseded work is cancelled;
the existing cache budgets remain. Tokenizer CPU time is not bounded by an elapsed-time limit.
