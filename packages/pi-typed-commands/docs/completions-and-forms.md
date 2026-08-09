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
relative to the raw argument string and is preserved in library-owned completion results for
adapters that support per-item ranges.

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

## Inline ghost text

`ghostText` is an opt-in command or subcommand definition. When configured, its text is dimmed directly after the exact invocation on the editor line:

```text
/deploy  choose a target
```

Only `/deploy` is editor content. The hint is presentation-only and remains visible through one trailing space. It disappears when the user types a second trailing space, enters a partial command or subcommand, starts an argument, creates multiline input, or moves the cursor away from the end. An exact subcommand or alias selects that branch's independently configured hint. Static strings and synchronous TypeScript resolvers are supported; commands without `ghostText` retain the normal editor.

The separate live helper continues to follow its existing `inlineHelp` policy. If another extension supplies an editor that cannot be safely decorated, Pi Typed Args leaves that editor intact and continues using the normal helper.

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

`Tab` completes unambiguous partial flags and fixed choices before opening the form. For example, `/branch -pro<Tab>` becomes `/branch --prompt ` and `/branch --layout sepa<Tab>` becomes `/branch --layout separate `. Fixed-choice completion also works with `--layout=sepa`, positional enums, and comma-separated `multi-enum` values. When there is no completion to apply, a completed command such as `/branch<Tab>` opens the dense form.

Inline errors are deferred while the user is still typing the current token. A value-taking flag such as `/branch --prompt ` stays quiet until a value is supplied, another argument is started, or the command is submitted.

Fixed enum choices use a contextual row by default while their value is being entered:

```text
[count=6] [--layout=<value>] [--keep-open]
          layout: separate  current-tab  new-tab
```

Set `appearance.inlineHelp.choiceDisplay` to `"inline"` to keep the choices inside the argument token instead:

```text
[count=6] [--layout=<separate|current-tab|new-tab>] [--keep-open]
```

Both modes respect `appearance.inlineHelp.metadata.enumValues`; disabling it hides the concrete choices.

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

Multiple `installTypedCommandUx()` calls composed into the same Pi host share one live UX bridge,
even though Pi gives each extension a scoped API object. Later explicit options are merged into that
bridge, so a custom extension can require double-Tab even when the standalone `pi-typed-args`
extension was loaded first.

Forms can also open automatically for missing required arguments or invalid values, depending on command options.

The selected field is marked with `›` and accented so users can tell which value arrow keys, space, or typing will edit.

Dense form presentation can be customized with `appearance.form`. The setting applies to extension commands and typed skills. Command metadata cannot override configured colors or layout.

The dense form uses Pi's injected semantic keybinding manager rather than fixed terminal keys. Pi defaults, `keybindings.json` overrides, and extension-contributed bindings therefore apply to submit, newline, selection, cursor movement, cancellation, tabbing, and undo. Footer hints are generated from the active bindings.

Completion-backed string fields use the same `complete`, `completeAsync`, path, directory, file, and command providers as the slash-command editor. Results retain labels and descriptions, and async providers keep the same cancellation and timeout behavior.

Forms keep command-level refinement failures open and associate messages with `path` and `relatedPaths`. They also show a live, sensitive-value-safe command preview, scroll long forms around the focused field, render grouped definitions as sections, distinguish true/false/unset booleans, and require explicit acceptance for `confirm` widgets.

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
values are staged for the exact command submitted by the form and consumed once when that command
runs.

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

`visibleWhen`, `enabledWhen`, and `requiredWhen` provide positive conditional rules. `disabled` is the inverse editing control, `copyFrom` initializes an unset value from another field, `section` names a form section, and `advanced: true` places the field in the Advanced section. Dense and sequential form adapters apply the same metadata.

`textarea` and `code` fields delegate editing to Pi's editor, so configured newline, cursor, undo, and submission bindings continue to work. Path-like and completion-backed fields use the editor's searchable completion list.

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
