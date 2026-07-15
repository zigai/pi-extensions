# Completions and Forms

Pi Typed Args derives completions and forms from the same argument definitions used by the parser.

## Completion providers

Add `complete` for synchronous suggestions, or `completeAsync` when producing suggestions requires
asynchronous work.

```ts
const command = defineTypedCommand({
  name: "checkout",
  description: "Checkout a git ref",
  args: {
    ref: {
      type: "string",
      required: true,
      completeAsync: async (query, context) => {
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
- `signal` - cancellation signal that is aborted when the completion request times out.

`complete` must return its items synchronously and is available to both editor and command-level
completion. `completeAsync` returns a promise and is invoked only by Pi's asynchronous command-level
completion hook, so synchronous editor completion never starts work that it cannot own. Provider
failures are contained: thrown errors, rejected promises, and invalid items produce no suggestions
instead of breaking completion. Async providers time out after 1000 ms by default; set
`completionTimeoutMs` on the argument to override that, or `0` to disable the timeout.

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

Set `replaceRange` when a provider has computed the exact source span to replace. The range is
relative to the raw argument string and must accompany a `replacement` value.

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

## Live editor helper

When the Pi UX bridge is installed, typed commands render a compact helper above the editor by default while a slash command is being typed. The helper shows active values first, including meaningful defaults such as `[count=1]`, then remaining available arguments in a dimmed style.

For example:

```text
/branch --worktree --pane-window
         [count=1] [--pane-window] [--worktree]  [--panes] [--keep-open] [--prompt <prompt>]
```

Set `helperPlacement` to `"belowEditor"` in `~/.pi/agent/pi-typed-args/config.json`, or pass `helperPlacement: "belowEditor"` to `installTypedCommandUx()` when composing a custom extension entrypoint, to render the helper below the user input editor instead.

Inline helper presentation can be customized with `appearance.inlineHelp` in the extension config. For example, enable type-rich tokens without changing command definitions:

```json
{
  "appearance": {
    "inlineHelp": {
      "metadata": { "types": true, "aliases": true },
      "order": "active-required-available"
    }
  }
}
```

`Tab` completes unambiguous partial flags before opening the form. For example, `/branch -pro<Tab>` becomes `/branch --prompt `. A completed command such as `/branch<Tab>` opens the dense form.

Inline errors are deferred while the user is still typing the current token. A value-taking flag such as `/branch --prompt ` stays quiet until a value is supplied, another argument is started, or the command is submitted.

## TUI forms

When installed through `registerTypedCommand()` and the Pi UI is available, typed commands can open a dense TUI form for missing or invalid values.

Users can open the form by typing a completed command and pressing Tab:

```text
/deploy<Tab>
```

Composed extensions can require two consecutive Tabs on unchanged editor text:

```ts
installTypedCommandUx(pi, { formTrigger: "double-tab" });
```

With this option, the first Tab arms the form shortcut and the second opens it. Typing any other
key or changing the command text resets the sequence.

Forms can also open automatically for missing required arguments or invalid values, depending on command options.

The selected field is marked with `›` and accented so users can tell which value arrow keys, space, or typing will edit.

Dense form presentation can be customized with `appearance.form`. The setting applies to extension commands and typed skills. Command metadata cannot override configured colors or layout.

## Form-only arguments

Set `formOnly: true` when an optional value must be available exclusively through the expanded
form:

```ts
args: {
  maximumTimeMinutes: {
    type: "number",
    integer: true,
    min: 1,
    formOnly: true,
    title: "Maximum active time (minutes)",
  },
}
```

Form-only arguments have no flag or positional spelling and are omitted from usage, help,
completion, helper, and serialization output. They cannot be required or define a default,
`flag`, `aliases`, `position`, or `rest`. After the user submits the expanded form, the validated
values are staged for the exact command text written back to the editor and consumed once when
that command runs.

## Form configuration

Command-level content options:

```ts
const command = defineTypedCommand({
  name: "deploy",
  description: "Deploy",
  args: {
    /* ... */
  },
  formTitle: "Deploy",
  formSymbols: {
    selectedCheckbox: "■",
    unselectedCheckbox: "□",
  },
  run() {},
});
```

Global symbols override command `formSymbols` only when the global symbol is configured; otherwise command-level symbols keep working.

Global form appearance example:

```json
{
  "appearance": {
    "form": {
      "symbols": {
        "focusedField": "»",
        "selectedCheckbox": "☑",
        "unselectedCheckbox": "☐"
      },
      "layout": {
        "minNameWidth": 10,
        "maxNameWidth": 30,
        "descriptions": "focused",
        "instructions": "short"
      }
    }
  }
}
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
