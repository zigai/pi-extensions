# Script Previews

Bash calls render as a `$` prompt with the finished duration at the right edge. Configure them with `scriptPreview` settings in `~/.pi/agent/extension-settings/pi-glowup.json`.

## Prompt Layout

Shell commands start beside the `$`. Standalone interpreter calls put the launcher beside the `$` and the highlighted source below it:

```text
$ python3 - <<'PY'                                    0.31s
  print('hi')
  print('bye')
hi
bye
```

`scriptPreview.shellOutputStyle` shows output flush left (`"terminal"`) or behind a dim `│` gutter (`"gutter"`).

## Shell Layout

`scriptPreview.shellLayout` controls display-only reflow for composed Bash commands. The default,
`"auto"`, always structures compound forms such as loops, conditionals, functions, and case
statements; simpler one-line commands reflow only when their submitted form would wrap. Use
`"preserve"` to keep the submitted layout or `"always"` to reflow every safely parsed command.

Reflowed chain and case operators stay at the end of the preceding row by default. Set
`scriptPreview.shellOperatorPosition` to `"leading"` to place them at the start of the next row.

Reflow uses the Bash syntax tree to place logical operators, pipelines, statements, and compound
shell bodies on readable rows. It keeps language blocks inside the composed Bash preview rather
than extracting them into separate tool calls. Ordinary quoted text and data heredocs stay intact.
Only clean standalone interpreter calls render as Python, Node, TypeScript, Bun, or Deno previews.
Single-quoted inline source inside a composed command remains in the Bash block but receives its
language's syntax highlighting when the interpreter can be identified safely.

### Embedded Heredoc Source

Configured language formatters also format complete source heredocs **in place** inside a Bash
block, including multiple Python/Node invocations followed by other shell commands. A standalone
Bash formatter is not required. `cat > example.py <<'PY'` and `cat > example.mts <<'EOF'` use the
static destination extension to select Python or JavaScript/TypeScript formatting. The Bash label,
command order, redirects, delimiters, and following commands remain visible.

Detection requires a source-reading interpreter invocation or a supported static code-file target;
a marker named `PY`/`JS` alone does not identify code. Data passed to a script filename or `-c`/`-e`
program, non-stdin descriptors, unquoted bodies with active shell expansions, and incomplete bodies
are not reformatted. If formatting would create a premature delimiter line, the original body stays.
Multiline strings inside formatted source (such as Rust embedded in a Python string) remain verbatim.

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
indentation. TSX reuses the TypeScript profile with the TSX parser rather than treating JSX as a
TypeScript type assertion. Bash uses two-space shfmt without simplification or minification; only a Bash profile
formats whole shell commands. Executables must already be installed and reachable, or use an
explicit executable path. `kind: "command"` accepts arbitrary formatter argv through `command`.

Profiles format asynchronously at the available content width and after resize. Oxfmt receives
`printWidth` through an owned temporary configuration; Tuff receives line length and an isolated
collection profile. Successful Python formatting also compacts root-level structural blank rows
before unindented code. The syntax worker's Python tokenizer protects strings, expressions, and
continuations; comment-adjacent and suite-internal gaps remain. This applies to Python command
profiles too.
Python/JS/TS profiles omit complete leading imports by default; `imports: "show"` retains them.
This import policy applies in statement and block streaming modes too.
Bash keeps setup statements and heredocs. Expanded Bash-tool and Codemode previews normally show
original source unless `streaming.code` is `"statement"`. Recognized embedded heredoc source stays
formatted in expanded Bash previews too; token mode retains the original surrounding shell layout.

Token-mode previews keep raw source until execution completes, then publish prepared decoration.
Statement mode formats each completed statement separately before revealing it; block mode waits for
complete code. Python headers followed only by comments wait for a real suite statement before
formatting. If a formatter declines a language or unit, original lexical spacing is retained rather
than reflowing an unformatted inline suite. Multiline Python/JavaScript/Bash literals and ordinary
heredoc payloads are protected during independent unit formatting and restored verbatim after
indentation. Recognized source heredocs use their own language formatter as described above. Script extraction retains tabs;
`<<-` strips leading tabs as the shell does, without changing interior tabs. Shell heredocs that the
parser cannot safely split hold their enclosing statement until completion. Supported statement
languages are JavaScript, TypeScript, Python, and Bash; other languages wait for completion.
Formatting never delays execution or changes submitted arguments. Incomplete examples and syntax
unsupported by the parser retain unformatted source spans without raising session warnings.
Successful output is cached by language, width, and source. Command profiles also accept
`{width}`, `{line_length}`, and `{cols}` argv placeholders.
Missing or failed executables produce a content-free warning once per language. Failures identify
an exit status, termination signal, timeout, or output limit without exposing code or formatter stderr;
undecorated source remains visible.

## Highlighting

Code within the 40 KiB source budget is tokenized off the TUI thread without a logical-line cutoff.
Plain source remains visible while full grammar-aware colors are pending. Superseded work is cancelled;
the existing cache budgets remain. Tokenizer CPU time is not bounded by an elapsed-time limit.
