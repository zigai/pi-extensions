# Command Definitions

A typed command starts as a user-authored definition. `defineTypedCommand()` validates and freezes the argument schema, preserves TypeScript inference, and attaches pure helpers for parsing, serialization, usage, and help.

## Define a command

```ts
import { defineTypedCommand } from "pi-typed-commands";

const deploy = defineTypedCommand({
  name: "deploy",
  description: "Deploy a ref",
  args: {
    env: { type: "enum", values: ["dev", "prod"], required: true },
    ref: { type: "string", default: "main" },
    dryRun: { type: "boolean" },
  },
  run(args, ctx) {
    ctx.ui.notify(`Deploy ${args.ref} to ${args.env}`);
  },
});
```

Inline enum arrays keep literal inference, so `args.env` is typed as `"dev" | "prod"`.

## Register with Pi

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTypedCommand } from "pi-typed-commands";

export default function extension(pi: ExtensionAPI): void {
  const handle = registerTypedCommand(pi, deploy);

  // Optional cleanup for wrapper-owned metadata.
  handle.dispose();
}
```

The returned handle exposes:

- `invocationName` - the actual slash command name, including Pi duplicate suffixes when needed;
- `parse(raw)` - parse raw command text without invoking the handler;
- `serialize(values)` - convert values back into CLI text;
- `formatUsage()` and `formatHelp()`;
- `dispose()` - remove wrapper-owned registry metadata safely.

## Parse manually

```ts
const result = deploy.parse("--env prod --dry-run");

if (result.status === "success") {
  result.value.env; // "dev" | "prod"
  result.value.ref; // string, defaulted to "main"
}

if (result.status === "error") {
  result.issues;
  result.partial;
  result.provided;
}
```

Parse results are discriminated by `status`: `"success"`, `"error"`, or `"help"`.

## Serialize values

```ts
const raw = deploy.serialize({ env: "prod", ref: "feature branch" });
// --env=prod --ref="feature branch"
```

Serialization quotes values when needed so the parser can read them back.

## Command-level refinement

Use `refine()` for cross-field validation after individual fields parse successfully.

```ts
const range = defineTypedCommand({
  name: "range",
  description: "Validate a range",
  args: {
    start: { type: "number", required: true },
    end: { type: "number", required: true },
  },
  refine(args) {
    if (args.start !== undefined && args.end !== undefined && args.start > args.end) {
      return [
        {
          code: "range.invalid",
          message: "start must not exceed end",
          path: ["start"],
          relatedPaths: [["end"]],
        },
      ];
    }
    return [];
  },
  run() {},
});
```

Keep refinement deterministic and synchronous. Put filesystem, network, or model checks in a separate pre-run stage.
