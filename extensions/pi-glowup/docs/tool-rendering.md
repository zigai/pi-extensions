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

## Components

Protocol components are semantic rather than visual:

- `call` renders a lifecycle-aware tool call.
- `output` renders bounded text output.
- `summary` renders label/value rows.
- `code` renders syntax-aware code.
- `list`, `text`, and `stack` compose structured content.
- `empty` intentionally renders nothing.

The protocol is intentionally a small composition vocabulary rather than a catalog of Glowup
features or known tools. Tool-specific previews should compose these nodes. Rich rendering that
cannot be expressed without embedding terminal layout into strings remains a Glowup-owned
specialization until a genuinely reusable semantic primitive is identified.

Use semantic tones and syntax metadata instead of applying colors yourself. The active Glowup
configuration controls label mode, colors, indicators, width wrapping, expansion hints, and
terminal safety.

## Partial and expanded rendering

`GlowupCallContext` reports the tool call id, lifecycle phase, argument completeness, partial state,
expanded state, image preference, and error state. Result rendering receives the original parsed
arguments through `GlowupResultContext`.

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
