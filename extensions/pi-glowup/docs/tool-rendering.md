# Glowup Tool Rendering

Tool owners can add a `glowupRendering` property to a Pi tool definition. Pi ignores this property
when `pi-glowup` is not installed. The property is a versioned, declarative protocol; it does not
expose Pi's TUI components, themes, ANSI sequences, or Glowup's internal modules.

Tool-specific rendering belongs next to the tool that owns its argument and result contracts. This
repository provides the protocol, style engine, generic compatibility renderer, and the remaining
transitional renderers for Agent Browser, MCP, and Pi UI questions. Goal rendering has migrated to
`pi-codex-goal`; current subagent rendering has migrated to `@zigai/pi-subagents`; and Codex
`apply_patch`, `web_run`, `imagegen`, and `view_image` rendering has migrated to
`pi-codex-core`. Other renderers stay here until each owning package ships and verifies an equivalent protocol adapter;
they are migrated independently rather than removed in advance.

## Rendering selection

For a tool, Glowup uses this order:

1. A configured preserve rule or `glowupRendering: "preserve"` keeps the original Pi renderer.
2. A valid tool-owned `glowupRendering` adapter supplies Glowup views.
3. A separately registered contribution supplies its protocol views.
4. A tool without an existing renderer uses its `outputSchema` and `structuredContent` for generated results.
5. Known tools retain transitional renderers; other existing renderers remain unchanged.
6. The generic renderer supplies slots without another renderer.

The generic renderer is deliberately domain-neutral. It uses the tool definition label when
available, produces bounded summaries, redacts secret-like fields, and does not infer semantics
from unknown tool names. Known transitional renderers retain their current domain-specific
summaries until migration is complete.

## Presentation and contributions

`@zigai/pi-glowup/presentation` exports `registerGlowupToolRenderer(name, matches, rendering)` for separate protocol contributions. Its handle updates the adapter and disposes registration idempotently. Owner adapters and preservation rules take precedence. Registration does not activate Glowup.

`registerGlowupPresentation(name, presentation)` installs a whole backend; `selectGlowupPresentation(name)` selects it for the session. Handles update or dispose the backend. Disposal restores the previous available selection or compact. The `presentation` setting selects the startup backend. Compact retains specialized previews; outline uses open headings, numbered lists, plain code and signed mutation rows. Backends own both semantic-node rendering and native/transitional renderer construction.

Generated results validate `structuredContent` against `outputSchema`, then display declared field titles and nested values. Missing, partial or invalid structured results retain diagnostics and textual output; tool errors retain their text. Generated results use the same expansion budgets as protocol output.

Glowup owns tool presentation and composition. Response Renderer independently owns assistant tables, fences, paragraph gaps and italic policy. Neither extension is retired; remaining transitional renderers stay until their owners replace them.

## Protocol version 3

Import only from `@zigai/pi-glowup/protocol`:

```ts
import {
  call,
  code,
  defineGlowupRenderer,
  output,
  stack,
  summary,
  withGlowupRendering,
  type GlowupRenderer,
} from "@zigai/pi-glowup/protocol";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type DbQueryArgs = {
  readonly database: string;
  readonly sql: string;
};

type DbQueryResult = {
  readonly details?: {
    readonly rowCount?: number;
  };
};

const glowupRendering = defineGlowupRenderer<DbQueryArgs, DbQueryResult>({
  version: 3,
  parseArgs(value) {
    if (typeof value !== "object" || value === null) return undefined;
    if (!("database" in value) || !("sql" in value)) return undefined;
    return typeof value.database === "string" && typeof value.sql === "string"
      ? { database: value.database, sql: value.sql }
      : undefined;
  },
  parseResult(value) {
    if (typeof value !== "object" || value === null) return undefined;
    if (!("details" in value) || typeof value.details !== "object" || value.details === null) {
      return {};
    }
    if (!("rowCount" in value.details) || typeof value.details.rowCount !== "number") {
      return { details: {} };
    }
    return { details: { rowCount: value.details.rowCount } };
  },
  renderPartialCall() {
    return call({ static: "DB Query", running: "Querying DB", completed: "Queried DB" });
  },
  renderCall(args) {
    return call(
      { static: "DB Query", running: "Querying DB", completed: "Queried DB" },
      {
        body: stack([
          summary([{ label: "Database", value: args.database }]),
          code(args.sql, { syntax: { language: "sql" } }),
        ]),
      },
    );
  },
  renderResult(result) {
    const rows = result.details?.rowCount ?? 0;
    return output(`${rows} rows`, { preview: { mode: "head" } });
  },
});

const typedCheck: GlowupRenderer<DbQueryArgs, DbQueryResult> = glowupRendering;

declare function queryDatabase(database: string, sql: string): Promise<unknown[]>;

export default function dbExtension(pi: ExtensionAPI) {
  pi.registerTool(
    withGlowupRendering(
      defineTool({
        name: "db_query",
        label: "DB Query",
        description: "Run a read-only SQL query.",
        parameters: Type.Object({
          database: Type.String(),
          sql: Type.String(),
        }),
        async execute(_toolCallId, params) {
          const rows = await queryDatabase(params.database, params.sql);
          return {
            content: [{ type: "text", text: JSON.stringify(rows) }],
            details: { rowCount: rows.length },
          };
        },
      }),
      typedCheck,
    ),
  );
}
```

Restored sessions, serialized tool calls, and third-party results cross a runtime boundary, so an
adapter must parse complete arguments before `renderCall` and results before `renderResult` can use
them. Incomplete streaming arguments go to `renderPartialCall` when it is defined; that callback
receives `unknown` and must inspect values before using them. Omitting it uses the normal fallback
until the complete arguments parse successfully. Returning `undefined` from a parser or render
method asks Glowup to use the fallback for that slot. Returning `empty()` intentionally suppresses
the slot.

## Reusing the Bash call preview

Shell tools with a `command` (or `cmd`) argument can opt into Glowup's native Bash call renderer:

```ts
const rendering = {
  version: 3,
  callStyle: { kind: "bash", background: true },
  // Keep the normal parseArgs/renderCall and result methods here.
};
```

`callStyle` changes only the call view. It reuses Bash highlighting, script formatting, streaming,
and expansion. The owner's result view stays the same, `renderCall` remains the fallback, and
explicit preserve rules still win.

With `background: true`, the compact preview shows a muted `` (U+EBE0; requires a Nerd Font) to the
left of the duration, or alone when the duration is unknown. The icon means the command runs in the
background, not that it finished. On a background-start tool, the duration covers the launch, not
the process it started.

## Components

Protocol components are semantic rather than visual:

- `call` renders a lifecycle-aware tool call, with an optional `state`.
- `output` renders bounded text output, with an optional `format: "markdown"`.
- `summary` renders label/value rows.
- `code` renders syntax-aware code.
- `mutation` renders responsive, syntax-aware per-file changes from semantic rows and an optional completed unified patch.
- `list`, `text`, and `stack` compose structured content. Lists take an optional `style`, and text takes optional `parts`.
- `empty` intentionally renders nothing.

### Call state

- `state: "running" | "success" | "error" | "muted"` uses the native `GlowupCallState` values.
- It overrides only that call's native indicator, color, and failure selection.
- For example, `call({ static: "Agent", completed: "Agent done", failed: "Agent failed" }, { state: "success" })` stays successful in a mixed failed tool result.
- Only an explicit `"error"` selects the failed label.
- Running and completed labels still follow the tool lifecycle, and static labels stay static.
- Without `state`, behavior is unchanged.
- The override does not affect sibling calls or nested body calls.
- Both the helper option and the structural `{ kind: "call", labels, state }` work.

### Markdown output

- `format: "markdown"` uses Pi's native Markdown renderer: headings, lists, inline formatting, and syntax-aware fences.
- Streaming policy runs before Markdown parsing.
- Preview budgets count rendered physical rows instead of source lines.
- `format` changes presentation only; add `streaming` to opt generated content into policy gating.
- Expanded output honors `expandedLines` (default 500), with an omission row when bounded.
- Compact protocol content keeps its Markdown instance across redraws and same-slot snapshots.
- This keeps Pi's parsing caches even above Glowup's row-cache budget.
- Changes to visible source, width, theme, and syntax refresh the matching caches.
- Streamed fence jobs belong to the visible source.
- Ordinary output is unchanged.

### Tree lists

- `list(items, preview?, style?)` accepts `style: "bullet" | "tree"`, also available on `GlowupListNode`.
- Without a style, lists keep the bullet presentation.
- `"tree"` uses the native read and search connectors, with continuation rails for multiline and wrapped items and no extra outer connector.
- For example, `call({ static: "Read" }, { body: list(["first.ts", "second.ts"], undefined, "tree") })`.
- Tree items render their child components: stacks, nested lists, styled text, Markdown output, and syntax-aware code.
- Only the rails are dimmed.
- Tree lists keep the shared head, head-tail, and hidden previews and the collapsed and expanded row budgets.
- The outline backend also honors tree style and rich content; its default list stays numbered.

### Text parts

- `text` accepts optional `parts: readonly GlowupInline[]`.
- Parts are joined without separators and replace the visible text.
- The `text` field stays as a plain fallback for older consumers.
- Each part has its own `tone` and `bold`.
- A call whose body is one text node, with or without parts, shows that text on the call line.
- Both `text(value, { parts })` and the structural `{ ...text(value), parts }` work.

Owners on older helper packages can emit these optional fields structurally, without Pi TUI imports or new helper imports:

```ts
stack([
  { ...text("Task · running"), parts: [
    { kind: "text", text: "Task", bold: true },
    { kind: "text", text: " · running", tone: "dim" },
  ] },
  { ...output("## Progress\n\n- Working on `file.ts`"), format: "markdown",
    preview: { mode: "head", collapsedLines: 6, expandedLines: 200 } },
]);
```

`output(source, { format: "markdown", preview })` is equivalent. Collapsed omission hints
use Pi's configured tool expansion key; expanded omission rows do not suggest further expansion.

The protocol is intentionally a small composition vocabulary rather than a catalog of Glowup
features or known tools. Tool-specific previews should compose these nodes. Rich rendering that
cannot be expressed without embedding terminal layout into strings remains a Glowup-owned
specialization until a genuinely reusable semantic primitive is identified.

Use semantic tones and syntax metadata instead of applying colors yourself. The active Glowup
configuration controls label mode, colors, indicators, width wrapping, expansion hints, and
terminal safety.

## Partial and expanded rendering

`GlowupCallContext` reports the tool call id, lifecycle phase, argument completeness, partial state,
expanded state, image preference, error state, and whether a settled or restored result is attached.
Result rendering receives the original parsed arguments through `GlowupResultContext`. An adapter
may set `independentExpansion: true` to let clicks expand its call and result separately when the
visible previews differ. Pi's global tool-expand key still expands or collapses both.

Protocol `output` components remain bounded even when expanded. Completed mutation diffs follow
the `mutations` configuration: the default full view keeps every available row, while preview mode
uses its configured row budget. Multi-file patches remain separate top-level mutation blocks. The
renderer always enforces width, Unicode, terminal-control, and configured safety limits after
applying style.

## Preserving an existing renderer

Use `preserve` when a tool should always keep its own Pi renderer:

```ts
pi.registerTool({
  name: "rich_tool",
  label: "Rich Tool",
  // parameters, execute, render, etc.
  glowupRendering: "preserve",
});
```

Users can also preserve tools through `preserveTools` in
`~/.pi/agent/extension-settings/pi-glowup.json`.

## Generated-content streaming contract

Streaming is presentation-only: never change execution arguments, model-visible results,
provider events, or persisted history. Call arguments and result output have separate stream
identities and completion boundaries. A completed argument object does **not** complete a
partial result. Compact and outline layouts use the same policy before bounding previews.

`code(source, { syntax: { language: "javascript" } })` declares generated code and inherits
`streaming.code`. A tool owner can opt generated result prose into the shared policy without
misclassifying terminal logs:

```ts
import { output } from "@zigai/pi-glowup/protocol";

output(currentText, {
  streaming: { kind: "markdown", key: "answer" },
});
```

The renderer supplies call/result completion. Use `complete: false` for a snapshot of an
independently running child, and `complete: true` when that child's block is finished. Keep
its key stable. `kind: "prose"` uses only prose boundaries; `"markdown"` also gates embedded
code; `"code"` uses the syntax language/path. `mode: "immediate"` is an explicit raw-display
override. Ordinary `output()` and `text()` remain immediate, even with syntax metadata;
mutations retain their independent diff policy.

Extension-owned views outside tool components can import `presentGlowupContent()` (synchronous,
with optional invalidation callback) or await `presentGlowupSnapshot()` from the same public
protocol. Supply a session-scoped key, content kind, original source and explicit completion.
Without an active Glowup policy these preserve the source. `registerGlowupStreamingPolicy()`
provides the replaceable policy seam; registrations are owned/disposed with their sessions,
and pending snapshots reject results across replacement/reset. Renderers do not read settings.

Assistant responses and thinking share this service. Thinking remains plain-styled. Indented
Markdown code has no declared language and waits for block completion instead of being treated
as prose. Unsupported languages and parser failures also hold unfinished input rather than
publishing speculative code. `!`/`!!`, terminal stdout/logs, raw transcript/history viewers,
and noninteractive/RPC transport are intentionally unaffected.

A tool-owned adapter may own only its call or only its result. Glowup preserves an explicitly
provided native renderer on the undeclared opposite side; adding a code-call adapter must not
silently replace a tool's result sanitization or recovery display with a generic fallback.
