# Arguments

Arguments describe the values a command accepts. The same definitions drive parsing, validation, generated help, completions, and forms.

## Built-in types

| Type         | Value type                 | Notes                                                                           |
| ------------ | -------------------------- | ------------------------------------------------------------------------------- |
| `string`     | `string`                   | Supports `minLength`, `maxLength`, `pattern`, `rest`, and text-like widgets.    |
| `number`     | `number`                   | Supports `integer`, `min`, and `max`.                                           |
| `boolean`    | `boolean`                  | Supports `--flag`, `--flag true`, `--flag false`, and `--no-flag`.              |
| `enum`       | one string from `values`   | Preserves literal unions when values are inline or built with `enumArgument()`. |
| `multi-enum` | string array from `values` | Supports repeated flags and comma-separated values.                             |

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
- `ui` - form presentation metadata.

`required: true` and `default` are mutually exclusive. A required argument must come from the user. A defaulted argument is optional but non-null in the handler.

## Argument builders

Builders are useful for separately declared schemas because they preserve literal types.

```ts
import { enumArgument, multiEnumArgument, stringArgument } from "pi-typed-commands";

const args = {
  env: enumArgument(["dev", "staging", "prod"], { required: true }),
  ref: stringArgument({ default: "main" }),
  tags: multiEnumArgument(["api", "web", "worker"]),
};
```

## Positionals

Prefer `position` for public CLI contracts:

```ts
args: {
  env: { type: "enum", values: ["dev", "prod"], position: 0, required: true },
  ref: { type: "string", position: 1, default: "main" },
}
```

Legacy `positional: true` and `positional: 0` remain accepted for migration, but `position` is clearer and more stable.

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
| `append` | Append values. Valid for `multi-enum`.                           |

`multi-enum` defaults to append and deduplicates selected values.

## Groups

Use `group()` when the handler should receive a nested object while CLI flags stay flat.

```ts
import { group, numberArgument, stringArgument } from "pi-typed-commands";

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
