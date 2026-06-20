# Completions and Forms

Pi Typed Commands derives completions and forms from the same argument definitions used by the parser.

## Completion providers

Add `complete` to an argument to provide value suggestions.

```ts
const command = defineTypedCommand({
  name: "checkout",
  description: "Checkout a git ref",
  args: {
    ref: {
      type: "string",
      required: true,
      complete: async (query, context) => {
        const refs = await listGitRefs(context.cwd);
        return refs.filter((ref) => ref.startsWith(query)).map((value) => ({ value }));
      },
    },
  },
  run() {},
});
```

The completion context contains:

- `values` - parsed values available before the cursor;
- `provided` - names supplied by the user;
- `cwd` - active working directory when available;
- `ctx` - Pi extension context when completions run through the Pi adapter;
- `signal` - cancellation signal that is aborted when the completion request times out.

Completion providers can return values synchronously or asynchronously. Provider failures are contained: thrown errors, rejected promises, and invalid items produce no suggestions instead of breaking completion. Async providers time out after 1000 ms by default; set `completionTimeoutMs` on the argument to override that, or `0` to disable the timeout.

## Replacement text

Completion items can provide a raw value or explicit replacement text.

```ts
complete: () => [
  {
    value: "feature branch",
    replacement: '"feature branch"',
  },
];
```

If no replacement is supplied, the adapter quotes inserted values when needed.

## Built-in completion sources

The completion engine supports:

- flag names;
- inline flag values such as `--env=p`;
- separate flag values such as `--env p`;
- positional values;
- `enum` and `multi-enum` values;
- `ui.widget: "path"` for filesystem entries;
- `ui.widget: "command"` for known typed commands.

It respects `--` as an end-of-options marker and keeps repeatable multi-enum flags available.

## TUI forms

When installed through `registerTypedCommand()` and the Pi UI is available, typed commands can open a dense TUI form for missing or invalid values.

Users can open the form by typing a completed command and pressing Tab:

```text
/deploy<Tab>
```

Forms can also open automatically for missing required arguments or invalid values, depending on command options.

## Form configuration

Command-level options:

```ts
registerTypedCommand(pi, command, {
  formTitle: "Deploy",
  formSymbols: {
    selectedCheckbox: "■",
    unselectedCheckbox: "□",
  },
});
```

Argument-level `ui` metadata:

```ts
args: {
  message: {
    type: "string",
    title: "Commit message",
    ui: { widget: "textarea", rows: 4 },
  },
  force: {
    type: "boolean",
    ui: { widget: "confirm" },
  },
}
```

Supported widget names are:

- `text`
- `textarea`
- `number`
- `toggle`
- `select`
- `radio`
- `multiselect`
- `path`
- `command`
- `readonly`
- `computed`
- `confirm`
- `custom`

`readOnly`, `hidden`, and `compute` can be static booleans or functions of the current form values.

## Custom widgets

TypeScript command definitions can attach custom renderer/input hooks:

```ts
ui: {
  widget: "custom",
  custom: {
    renderValue(ctx) {
      return `current=${ctx.formatValue(ctx.value)}`;
    },
    handleInput(ctx) {
      ctx.setValue("updated");
      return true;
    },
  },
}
```

Custom widget contexts can see read-only whole-form values and can update one or more values through typed setter methods.
