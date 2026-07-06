# Codex-Look Tool Rendering

Third-party extensions can add `codexLookRendering` to a tool definition to control how that tool appears when `pi-codex-look` is installed. Pi ignores this property when the extension is not installed.

## Rendering Paths

`pi-codex-look` has four rendering paths:

- **Built-in Codex-look renderers** are internal renderers for Pi/Codex tools this extension knows well.
- **Original Pi renderers** are renderers already provided by a third-party tool.
- **Compatibility renderers** are generic Codex-look renderers used for third-party tools that do not provide their own renderer.
- **Passive adapters** are third-party `codexLookRendering` adapters that provide a compact Codex-look view without replacing the normal Pi renderer globally.

## Selection Order

For a third-party tool, rendering is selected in this order:

1. If the tool is preserved by config or by `codexLookRendering: "preserve"`, use its original Pi rendering.
2. If the tool defines a `codexLookRendering` adapter, use that adapter.
3. If the tool already has its own Pi renderer, keep that renderer.
4. Otherwise, use the generic compatibility renderer.

This means existing rich tool renderers are preserved by default. A tool author only needs `codexLookRendering` when they want a specific Codex-look presentation.

## Preserve A Tool Renderer

Use `"preserve"` when a tool should always keep its own Pi renderer, even if compatibility rendering is enabled:

```ts
pi.registerTool({
  name: "rich_tool",
  label: "Rich Tool",
  // parameters, execute, render, etc.
  codexLookRendering: "preserve",
});
```

Users can also preserve tools from config with `preserveTools` in `~/.pi/agent/pi-codex-look/config.json`.

## When An Adapter Helps

The generic compatibility renderer can already preview args and results. A passive adapter is useful when the tool knows information the fallback cannot infer:

- which fields are important enough to show in the collapsed call
- which fields are noisy or sensitive and should be hidden
- how to label the action in domain language
- how to summarize results without dumping raw output
- which syntax or preview limits make the output readable

For tiny tools with already-clear args and output, the fallback renderer may be good enough.

## Typed Adapter Example

Define the adapter next to the tool's typed args/result contract. Then pass those types to `CodexLookRenderingAdapter` and render from typed values directly.

```ts
import type { CodexLookRenderingAdapter } from "pi-codex-look/protocol";

type DbQueryArgs = {
  readonly database: string;
  readonly sql: string;
  readonly params?: readonly unknown[];
  readonly connectionId?: string;
};

type DbQueryResult = {
  readonly details?: {
    readonly rowCount?: number;
    readonly durationMs?: number;
  };
};

const codexLookRendering = {
  version: 1,
  renderCall({ database, sql }) {
    return {
      kind: "call",
      label: `Query ${database}`,
      body: sql,
      maxRenderedLines: 6,
    };
  },
  renderResult({ details }) {
    return {
      kind: "sections",
      sections: [
        { kind: "summary", label: "Rows", text: String(details?.rowCount ?? 0) },
        { kind: "summary", label: "Time", text: `${details?.durationMs ?? 0}ms` },
      ],
    };
  },
} satisfies CodexLookRenderingAdapter<DbQueryArgs, DbQueryResult>;

pi.registerTool({
  name: "db_query",
  label: "DB Query",
  // parameters, execute, etc.
  codexLookRendering,
});
```

In this example the adapter intentionally shows `database`, `sql`, row count, and timing. It omits fields like `params` and `connectionId` from the collapsed call because the fallback renderer cannot know whether those fields are useful, noisy, or sensitive.

## Untyped Boundaries

The default adapter generics are `unknown` because `pi-codex-look` can discover renderers from tools it did not compile with. If the adapter is not colocated with the tool's typed contract, parse or guard incoming values at the boundary before rendering.

Keep those guards in a small parser rather than scattering `Reflect.get` checks through the renderer body. Return `undefined` from `renderCall` or `renderResult` when the adapter cannot safely render; `pi-codex-look` will fall back to the compatibility renderer.
