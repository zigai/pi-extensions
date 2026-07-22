# Glowup Tool Rendering

Tool owners can add a `glowupRendering` property to a Pi tool definition. Pi ignores this property
when `pi-glowup` is not installed. The property is a versioned, declarative protocol; it does not
expose Pi's TUI components, themes, ANSI sequences, or Glowup's internal modules.

Tool-specific rendering belongs next to the tool that owns its argument and result contracts. This
repository provides the protocol, style engine, generic compatibility renderer, and the remaining
transitional renderers for Agent Browser, MCP, goals, agents, questions, and `apply_patch`. The
Codex `web_run`, `imagegen`, and `view_image` renderers have migrated to `pi-codex-core`. Other
renderers stay here until each owning package ships and verifies an equivalent protocol adapter;
they are migrated independently rather than removed in advance.

## Rendering selection

For a tool, Glowup uses this order:

1. A configured preserve rule or `glowupRendering: "preserve"` keeps the original Pi renderer.
2. A valid tool-owned `glowupRendering` adapter supplies Glowup views.
3. A known tool without an owner adapter uses its transitional compatibility renderer in Glowup.
4. An existing renderer for any other tool remains unchanged.
5. The generic compatibility renderer is used only when no renderer exists.

The generic renderer is deliberately domain-neutral. It uses the tool definition label when
available, produces bounded summaries, redacts secret-like fields, and does not infer semantics
from unknown tool names. Known transitional renderers retain their current domain-specific
summaries until migration is complete.

## Protocol version 2

Import only from `pi-glowup/protocol`:

```ts
import {
  call,
  code,
  defineGlowupRenderer,
  output,
  stack,
  summary,
  type GlowupRenderer,
} from "pi-glowup/protocol";

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
  version: 2,
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

pi.registerTool({
  name: "db_query",
  label: "DB Query",
  // parameters, execute, and the tool's own renderer...
  glowupRendering: typedCheck,
});
```

The generic parameters are compile-time guidance only. Restored sessions, serialized tool calls,
and third-party results still cross a runtime boundary, so adapters should parse values before
using them. Returning `undefined` from a parser or render method asks Glowup to use the generic
fallback for that slot. Returning `empty()` intentionally suppresses the slot.

## Components

Protocol components are semantic rather than visual:

- `call` renders a lifecycle-aware tool call.
- `output` renders bounded text output.
- `summary` renders label/value rows.
- `code` renders syntax-aware code.
- `list`, `text`, and `stack` compose structured content.
- `empty` intentionally renders nothing.

Use semantic tones and syntax metadata instead of applying colors yourself. The active Glowup
configuration controls label mode, colors, indicators, width wrapping, expansion hints, and
terminal safety.

## Partial and expanded rendering

`GlowupCallContext` reports the tool call id, lifecycle phase, argument completeness, partial state,
expanded state, image preference, and error state. Result rendering receives the original parsed
arguments through `GlowupResultContext`.

All output remains bounded even when expanded. The renderer enforces width, Unicode, terminal
control, and preview-size limits after applying style.

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
`~/.pi/agent/pi-glowup/config.json`.
