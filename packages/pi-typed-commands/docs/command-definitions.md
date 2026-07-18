# Command Definitions

A typed command starts as a user-authored definition. `defineTypedCommand()` validates and freezes the argument schema, preserves TypeScript inference, and attaches pure helpers for parsing, serialization, usage, and help.

## Define a command

```ts
import { defineTypedCommand } from "pi-typed-args";

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
import { registerTypedCommand } from "pi-typed-args";

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

Use `refine()` for cross-field validation after individual fields parse successfully. Its `args` parameter is a `ParsedArgumentDraft<TDefinitions>`, so every field is optional even if the handler later receives required/defaulted fields as present.

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

## Subcommands

Use `subcommands` for CLI-style branches with their own arguments, refinements, form metadata, and colocated handlers. Root `args` are shared by every branch. A root `run` handler is optional; when present, invoking the command without a subcommand runs it.

```ts
const workspace = defineTypedCommand({
  name: "workspace",
  description: "Manage workspaces",
  args: {
    verbose: { type: "boolean", default: false },
  },
  run(args) {
    // /workspace --verbose
  },
  subcommands: {
    create: {
      description: "Create a workspace",
      aliases: ["new"],
      args: {
        path: { type: "string", required: true },
      },
      run(args) {
        // args.path and the shared args.verbose are typed here
      },
    },
    remove: {
      description: "Remove a workspace",
      args: {
        force: { type: "boolean", ui: { widget: "confirm" } },
      },
      run(args) {},
    },
  },
});
```

```text
/workspace create --path demo --verbose
/workspace new --path demo
/workspace remove --force
```

The subcommand token comes first. Shared arguments are flags and may appear after it; shared positional arguments are rejected because they would make branch selection ambiguous. Shared and local argument keys may not collide.

`/workspace --help` lists the branches, while `/workspace create --help` shows branch-specific help. Completion and inline help suggest subcommands before one is selected, then switch to only the selected branch's grammar. Tab on the root opens a subcommand picker; Tab after a selected branch opens that branch's form.

`parse()` adds a `subcommand` discriminant for branch results. Use `serializeSubcommand()` to include the branch token:

```ts
workspace.serializeSubcommand({
  subcommand: "create",
  args: { path: "feature branch", verbose: true },
});
// create --verbose --path="feature branch"
```

Set `formPolicy` on the root or an individual subcommand to `"manual"`, `"missing"`, `"invalid"`, or `"always"`. The default is `"missing"`.

Set `inlineHelp: "hidden"` when a command should retain typed parsing, completion, and Tab-opened forms without rendering the compact live helper above or below the editor. The default is `"auto"`.

## Inline ghost text

Set `ghostText` to opt into dimmed, visual-only text on the same line as an exact slash-command invocation. It may be a static string or a synchronous resolver:

```ts
const deploy = defineTypedCommand({
  name: "deploy",
  description: "Deploy services and websites",
  args: {},
  ghostText: ({ ctx }) => `choose a target in ${ctx.cwd}`,
  run() {},
  subcommands: {
    service: {
      description: "Deploy a service",
      aliases: ["svc"],
      ghostText: "choose a service",
      args: {},
      run() {},
    },
    website: {
      description: "Deploy the website",
      ghostText: ({ ctx }) => `deploy the website from ${ctx.cwd}`,
      args: {},
      run() {},
    },
  },
});
```

`/deploy` shows the root hint. `/deploy service` and `/deploy svc` show the `service` hint, while `/deploy website` shows the `website` hint. Root and branch definitions are independent and are not inherited. The hint remains visible through trailing whitespace, so `/deploy ` keeps the root hint and `/deploy service ` keeps the branch hint. Partial commands, partial subcommands, arguments containing non-whitespace input, multiline input, empty resolver output, and resolver failures show no ghost text. The resolver receives `ctx`, the root `commandName`, and the canonical `subcommand` when a branch is selected. Keep it synchronous and side-effect free because it runs during editor rendering.

Ghost text is never inserted into editor content, history, or submitted input. Omitting `ghostText` preserves the normal editor exactly.
Line breaks and terminal control characters in resolved text are converted to spaces so the hint remains on one editor line.

Set `formPresets: true` to enable project-scoped recent values and named presets in the Tab-opened form workflow. After editing, users can apply values directly or save and apply a named preset. Sensitive fields are never persisted. Trusted projects store presets under Pi's project configuration directory; other contexts use the global agent directory. Malformed preset files are reported and never overwritten.

`parse()` error results also expose `partial` as `ParsedArgumentDraft<TDefinitions>`. `serialize(values)` accepts `SerializableArgumentValues<TDefinitions>`, a readonly object containing only the fields to emit.
