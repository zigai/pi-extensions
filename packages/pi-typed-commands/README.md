# Pi Typed Commands

[![npm version](https://img.shields.io/npm/v/pi-typed-commands.svg?color=blue)](https://www.npmjs.com/package/pi-typed-commands)
[![npm downloads](https://img.shields.io/npm/dm/pi-typed-commands.svg)](https://www.npmjs.com/package/pi-typed-commands)
[![license](https://img.shields.io/npm/l/pi-typed-commands.svg)](LICENSE)

Pi Typed Commands is a TypeScript library for adding typed inputs to Pi slash commands and Agent Skills. Define arguments once, then use them for parsing, validation, completion hints, generated help, live usage hints, and TUI input forms.

Use it inside your own Pi extension when commands or skills need structured input instead of hand-parsed raw strings.

## Install

Add the library to the package that contains your Pi extension:

```sh
npm install pi-typed-commands
```

Or add it manually to your extension package manifest:

```json
{
  "dependencies": {
    "pi-typed-commands": "^0.1.0"
  }
}
```

Then import it from your extension code:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTypedCommand, registerTypedCommand } from "pi-typed-commands";

const deploy = defineTypedCommand({
  name: "deploy",
  description: "Deploy a ref",
  args: {
    env: {
      type: "enum",
      values: ["dev", "staging", "prod"],
      position: 0,
      required: true,
      description: "Target environment",
    },
    ref: {
      type: "string",
      default: "main",
      description: "Git ref",
    },
    dryRun: {
      type: "boolean",
      description: "Preview only",
    },
  },
  async run({ env, ref, dryRun }, ctx) {
    ctx.ui.notify(`Deploy ${ref} to ${env}; dryRun=${String(dryRun)}`);
  },
});

export default function extension(pi: ExtensionAPI): void {
  registerTypedCommand(pi, deploy);
}
```

Users of your extension can then run:

```text
/deploy staging --ref feature/login --dry-run
/deploy<Tab>       # open the argument form
/deploy --help     # show generated help
```

While users type a command, Pi shows a compact live helper below the editor with parsed values, defaults, and remaining arguments. `Tab` completes an unambiguous partial flag such as `/deploy --r<Tab>` to `/deploy --ref `, or opens the form from a completed command such as `/deploy<Tab>`. Inline validation waits until the user moves past an argument or submits the command, so value-taking flags do not error while their value is still being typed.

## Supported argument types

| Type         | What it is for                             | Common options                                                     |
| ------------ | ------------------------------------------ | ------------------------------------------------------------------ |
| `string`     | Text, paths, names, refs, freeform values  | `minLength`, `maxLength`, `pattern`, `default`, `position`, `rest` |
| `number`     | Numeric values                             | `integer`, `min`, `max`, `default`                                 |
| `boolean`    | Flags and toggles                          | `--flag`, `--flag true`, `--no-flag`, `default`                    |
| `enum`       | One value from a fixed set                 | `values`, `default`, `position`                                    |
| `multi-enum` | Multiple values from a fixed set           | repeated flags, comma-separated values, no commas in values        |
| `group()`    | Nested handler objects with flat CLI flags | `group({ host, port })` becomes flags like `--database-host`       |

All argument definitions can also use common metadata such as `description`, `title`, `required`, `flag`, `aliases`, `placeholder`, `occurrence`, `complete`, `completionTimeoutMs`, and `ui`.

## Documentation

- [`command-definitions`](docs/command-definitions.md)
- [`arguments`](docs/arguments.md)
- [`completions-and-forms`](docs/completions-and-forms.md)
- [`skills`](docs/skills.md)
- [`configuration`](docs/configuration.md)

## License

[MIT](LICENSE)
