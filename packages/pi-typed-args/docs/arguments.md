# Arguments

Arguments describe the values a command accepts. The same definitions drive parsing, validation, generated help, completions, and forms.

## Built-in types

| Type          | Value type                          | Notes                                                                           |
| ------------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| `string`      | `string`                            | Supports `minLength`, `maxLength`, `pattern`, `rest`, and text-like widgets.    |
| `number`      | `number`                            | Supports `integer`, `min`, and `max`.                                           |
| `boolean`     | `boolean`                           | Supports `--flag`, `--flag true`, `--flag false`, and `--no-flag`.              |
| `enum`        | one string from `values`            | Preserves literal unions when values are inline or built with `enumArgument()`. |
| `multi-enum`  | readonly string array from `values` | Supports repeated flags and comma-separated values.                             |
| `string-list` | readonly string array               | Repeatable freeform strings from repeated flags or comma-separated values.      |
| `key-value`   | readonly string record              | Repeatable `key=value` entries returned as a readonly record.                   |

Use `optionDescriptions` on an `enum` to explain each choice in an expanded radio form:

```ts
layout: {
  type: "enum",
  values: ["separate", "current-tab", "new-tab"],
  optionDescriptions: {
    separate: "One tab/window per fork",
    "current-tab": "Add panes beside the current Pi session",
    "new-tab": "Put all forks in one new split tab/window",
  },
  ui: { widget: "radio" },
}
```

## Shared fields

Most arguments can use:

- `description` - help/completion/form text;
- `title` - human-readable field label;
- `required` - the caller must provide the value;
- `default` - value used when omitted;
- `flag` - explicit CLI flag name without leading dashes;
- `aliases` - additional flag names;
- `placeholder` - usage/help hint;
- `position` - positional index;
- `rest` - consume remaining positional values;
- `occurrence` - duplicate flag policy;
- `complete` - value completion provider;
- `completionTimeoutMs` - async completion timeout in milliseconds, defaulting to 1000 and disabled with `0`;
- `ui` - form presentation metadata.
- `examples` - example values shown in detailed help.

Strings can use semantic `format` validation for `email`, `url`, `date`, `time`, `datetime`, `duration`, and `json`. Set `sensitive: true` for masked form input and redacted helper/default output. Sensitive values are omitted from serialization and staged privately when a form submits the rest of a command.

Numbers support `step` and `unit`; a stepped number uses the `stepper` form control by default.

Additional form widgets include `secret`, `file`, `directory`, `list`, `key-value`, `duration`, `date`, `time`, `datetime`, `url`, `email`, `json`, `code`, and `stepper`.

`required: true` and `default` are mutually exclusive. A required argument must come from the user. A defaulted argument is optional but non-null in the handler. TypeScript rejects that combination in public definition types, and runtime validation reports it for untyped/loaded schemas.

Public `ArgumentDefinitions` maps are readonly inputs and may include `group()` entries. Parser-facing maps that have already expanded groups use `FlatArgumentDefinitions`.

## Argument builders

Builders are useful for separately declared schemas because they preserve literal types.

```ts
import { enumArgument, multiEnumArgument, stringArgument } from "pi-typed-args";

const args = {
  env: enumArgument(["dev", "staging", "prod"], { required: true }),
  ref: stringArgument({ default: "main" }),
  tags: multiEnumArgument(["api", "web", "worker"]),
};
```

## Positionals

Use `position` for public CLI contracts:

```ts
args: {
  env: { type: "enum", values: ["dev", "prod"], position: 0, required: true },
  ref: { type: "string", position: 1, default: "main" },
}
```

Rules enforced by the compiler include:

- positions must be non-negative integers;
- positions must be unique;
- required positionals cannot follow optional/defaulted positionals;
- only string and multi-enum arguments can use `rest: true`.

## Duplicate occurrence policies

`occurrence` controls repeated flags:

| Policy   | Behavior                                                         |
| -------- | ---------------------------------------------------------------- |
| `error`  | Report a duplicate argument issue. Default for scalar arguments. |
| `first`  | Keep the first value and ignore later occurrences.               |
| `last`   | Keep the last value.                                             |
| `append` | Append values. Valid for collection arguments.                   |

Collection arguments default to append. `multi-enum` deduplicates selections, while `string-list` preserves repeated items. Required collections must contain at least one item or entry. Because collection values use comma-separated CLI syntax, `multi-enum.values` and `string-list` items may not contain commas. String-list items must also be non-empty and may not start or end with whitespace. Key-value keys must be non-empty, trimmed, and contain neither commas nor equals signs; values may not contain commas.

## Groups

Use `group()` when the handler should receive a nested object while CLI flags stay flat.

```ts
import { group, numberArgument, stringArgument } from "pi-typed-args";

const command = defineTypedCommand({
  name: "database",
  description: "Configure database access",
  args: {
    database: group({
      host: stringArgument({ required: true }),
      port: numberArgument(),
    }),
  },
  run(args) {
    args.database.host; // string
    args.database.port; // number | undefined
  },
});
```

The CLI uses dotted keys converted to flags:

```text
/database --database-host localhost --database-port 5432
```

## Validation examples

Invalid definitions are rejected before registration. Examples include:

- `min > max` or `minLength > maxLength`;
- invalid regular expressions;
- empty or duplicate enum values;
- `minItems > maxItems`;
- duplicate flags or aliases;
- `required: true` combined with `default`;
- unsupported widget/type combinations.
