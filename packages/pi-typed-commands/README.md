# Pi Typed Args

[![npm version](https://img.shields.io/npm/v/pi-typed-args.svg?color=blue)](https://www.npmjs.com/package/pi-typed-args)
[![npm downloads](https://img.shields.io/npm/dm/pi-typed-args.svg)](https://www.npmjs.com/package/pi-typed-args)
[![license](https://img.shields.io/npm/l/pi-typed-args.svg)](LICENSE)

Pi Typed Args is a TypeScript library for adding typed inputs to Pi slash commands and Agent Skills. Define arguments once, then use them for parsing, validation, completion hints, generated help, live usage hints, and TUI input forms.

Use it inside your own Pi extension when commands or skills need structured input instead of hand-parsed raw strings.

## Install

Add the library to the package that contains your Pi extension:

```sh
npm install pi-typed-args
```

Or add it manually to your extension package manifest:

```json
{
  "dependencies": {
    "pi-typed-args": "^0.1.0"
  }
}
```

Then import it from your extension code:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTypedCommand, registerTypedCommand } from "pi-typed-args";

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

While users type a command, Pi shows a compact live helper above the editor by default with parsed values, defaults, and remaining arguments. `Tab` completes unambiguous partial flags and fixed choices—for example, `/deploy --r<Tab>` becomes `/deploy --ref ` and `/branch --layout sepa<Tab>` becomes `/branch --layout separate `—or opens the form when there is nothing to complete. Inline validation waits until the user moves past an argument or submits the command, so value-taking flags do not error while their value is still being typed.

Commands can opt into visual-only ghost text on the same editor line. It appears after an exact command or subcommand invocation, remains through one trailing space, and disappears when the user types a second space or starts an argument:

```ts
const deploy = defineTypedCommand({
  name: "deploy",
  description: "Deploy a ref",
  ghostText: ({ ctx }) => `choose a target in ${ctx.cwd}`,
  args: {},
  run() {},
});
```

The ghost text is dimmed presentation; it is never added to the submitted editor value. Omitting `ghostText` leaves the editor unchanged.

If you compose the Pi UX bridge yourself, move the helper below the input editor with:

```ts
import { installTypedCommandUx } from "pi-typed-args";

installTypedCommandUx(pi, { helperPlacement: "belowEditor" });
```

## Configuration

Use global config at `~/.pi/agent/pi-typed-args/config.json`.

| Option                                          | Default                       | Purpose                                                |
| ----------------------------------------------- | ----------------------------- | ------------------------------------------------------ |
| `helperPlacement`                               | `"aboveEditor"`               | Place the live helper above or below the input editor. |
| `appearance.form.colors.title`                  | `"accent"`                    | Color the dense form title.                            |
| `appearance.form.colors.focusedLabel`           | `"accent"`                    | Color the focused field label.                         |
| `appearance.form.colors.focusedValue`           | `"accent"`                    | Color the focused field value.                         |
| `appearance.form.colors.unsetValue`             | `"muted"`                     | Color unset field values.                              |
| `appearance.form.colors.description`            | `"dim"`                       | Color field descriptions.                              |
| `appearance.form.colors.instructions`           | `"dim"`                       | Color form instructions.                               |
| `appearance.form.colors.issue`                  | `"warning"`                   | Color validation issues.                               |
| `appearance.form.colors.editorBorder`           | `"accent"`                    | Color the form editor border.                          |
| `appearance.form.colors.selectedOption`         | `"accent"`                    | Color selected checkbox and radio options.             |
| `appearance.form.symbols.focusedField`          | `"›"`                         | Mark the focused field.                                |
| `appearance.form.symbols.selectedCheckbox`      | `"■"`                         | Mark selected checkboxes.                              |
| `appearance.form.symbols.unselectedCheckbox`    | `"□"`                         | Mark unselected checkboxes.                            |
| `appearance.form.symbols.selectedRadio`         | `"●"`                         | Mark selected radio options.                           |
| `appearance.form.symbols.unselectedRadio`       | `"○"`                         | Mark unselected radio options.                         |
| `appearance.form.layout.leftPadding`            | `1`                           | Set dense form left padding.                           |
| `appearance.form.layout.fieldGap`               | `1`                           | Set the gap between field labels and values.           |
| `appearance.form.layout.minNameWidth`           | `12`                          | Set the minimum field-name column width.               |
| `appearance.form.layout.maxNameWidth`           | `24`                          | Set the maximum field-name column width.               |
| `appearance.form.layout.minValueWidth`          | `12`                          | Set the minimum field-value column width.              |
| `appearance.form.layout.maxValueWidth`          | `32`                          | Set the maximum field-value column width.              |
| `appearance.form.layout.descriptions`           | `"inline"`                    | Show descriptions inline, focused, or hidden.          |
| `appearance.form.layout.instructions`           | `"full"`                      | Show full, short, or hidden instructions.              |
| `appearance.inlineHelp.layout`                  | `"compact"`                   | Use the compact live-helper layout.                    |
| `appearance.inlineHelp.choiceDisplay`           | `"contextual"`                | Show fixed choices contextually or inside tokens.      |
| `appearance.inlineHelp.order`                   | `"active-required-available"` | Order active, required, and available tokens.          |
| `appearance.inlineHelp.metadata.types`          | `false`                       | Show type metadata in the live helper.                 |
| `appearance.inlineHelp.metadata.defaults`       | `true`                        | Show default values in the live helper.                |
| `appearance.inlineHelp.metadata.required`       | `false`                       | Show required markers in the live helper.              |
| `appearance.inlineHelp.metadata.aliases`        | `false`                       | Show aliases in the live helper.                       |
| `appearance.inlineHelp.metadata.descriptions`   | `false`                       | Show descriptions in the live helper.                  |
| `appearance.inlineHelp.metadata.enumValues`     | `true`                        | Show enum values in the live helper.                   |
| `appearance.inlineHelp.colors.active`           | `"accent"`                    | Color active argument tokens.                          |
| `appearance.inlineHelp.colors.required`         | `"warning"`                   | Color required argument tokens.                        |
| `appearance.inlineHelp.colors.available`        | `"dim"`                       | Color available argument tokens.                       |
| `appearance.inlineHelp.colors.type`             | `"syntaxType"`                | Color type hints.                                      |
| `appearance.inlineHelp.colors.metadata`         | `"muted"`                     | Color metadata tokens.                                 |
| `appearance.inlineHelp.colors.issue`            | `"error"`                     | Color live-helper issues.                              |
| `appearance.inlineHelp.format.tokenPrefix`      | `"["`                         | Prefix each live-helper token.                         |
| `appearance.inlineHelp.format.tokenSuffix`      | `"]"`                         | Suffix each live-helper token.                         |
| `appearance.inlineHelp.format.groupSeparator`   | `"  "`                        | Separate token groups.                                 |
| `appearance.inlineHelp.format.itemSeparator`    | `" "`                         | Separate items within token groups.                    |
| `appearance.inlineHelp.format.typeSeparator`    | `":"`                         | Separate names from type hints.                        |
| `appearance.inlineHelp.format.valueSeparator`   | `"="`                         | Separate names from values.                            |
| `appearance.detailedHelp.metadata.types`        | `true`                        | Show types in generated help.                          |
| `appearance.detailedHelp.metadata.defaults`     | `true`                        | Show defaults in generated help.                       |
| `appearance.detailedHelp.metadata.required`     | `true`                        | Show required markers in generated help.               |
| `appearance.detailedHelp.metadata.aliases`      | `false`                       | Show aliases in generated help.                        |
| `appearance.detailedHelp.metadata.descriptions` | `true`                        | Show descriptions in generated help.                   |
| `appearance.detailedHelp.metadata.enumValues`   | `true`                        | Show enum values in generated help.                    |
| `appearance.detailedHelp.order`                 | `"definition"`                | Order arguments by definition or required-first.       |

```json
{
  "$schema": "./config.schema.json",
  "helperPlacement": "aboveEditor",
  "appearance": {
    "form": {
      "colors": {
        "title": "accent",
        "focusedLabel": "accent",
        "focusedValue": "accent",
        "unsetValue": "muted",
        "description": "dim",
        "instructions": "dim",
        "issue": "warning",
        "editorBorder": "accent",
        "selectedOption": "accent"
      },
      "symbols": {
        "focusedField": "›",
        "selectedCheckbox": "■",
        "unselectedCheckbox": "□",
        "selectedRadio": "●",
        "unselectedRadio": "○"
      },
      "layout": {
        "leftPadding": 1,
        "fieldGap": 1,
        "minNameWidth": 12,
        "maxNameWidth": 24,
        "minValueWidth": 12,
        "maxValueWidth": 32,
        "descriptions": "inline",
        "instructions": "full"
      }
    },
    "inlineHelp": {
      "layout": "compact",
      "choiceDisplay": "contextual",
      "order": "active-required-available",
      "metadata": {
        "types": false,
        "defaults": true,
        "required": false,
        "aliases": false,
        "descriptions": false,
        "enumValues": true
      },
      "colors": {
        "active": "accent",
        "required": "warning",
        "available": "dim",
        "type": "syntaxType",
        "metadata": "muted",
        "issue": "error"
      },
      "format": {
        "tokenPrefix": "[",
        "tokenSuffix": "]",
        "groupSeparator": "  ",
        "itemSeparator": " ",
        "typeSeparator": ":",
        "valueSeparator": "="
      }
    },
    "detailedHelp": {
      "metadata": {
        "types": true,
        "defaults": true,
        "required": true,
        "aliases": false,
        "descriptions": true,
        "enumValues": true
      },
      "order": "definition"
    }
  }
}
```

## Supported argument types

| Type          | What it is for                             | Common options                                                     |
| ------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| `string`      | Text, paths, names, refs, freeform values  | `minLength`, `maxLength`, `pattern`, `default`, `position`, `rest` |
| `number`      | Numeric values                             | `integer`, `min`, `max`, `default`                                 |
| `boolean`     | Flags and toggles                          | `--flag`, `--flag true`, `--no-flag`, `default`                    |
| `enum`        | One value from a fixed set                 | `values`, `optionDescriptions`, `default`, `position`              |
| `multi-enum`  | Readonly multiple values from a fixed set  | repeated flags, comma-separated values, no commas in values        |
| `string-list` | Readonly freeform string values            | repeated flags, comma-separated values, `minItems`, `maxItems`     |
| `key-value`   | Readonly string record                     | repeated `key=value` entries, `minItems`, `maxItems`               |
| `group()`     | Nested handler objects with flat CLI flags | `group({ host, port })` becomes flags like `--database-host`       |

All argument definitions can also use common metadata such as `description`, `title`, `required`, `flag`, `aliases`, `placeholder`, `occurrence`, `complete`, `completionTimeoutMs`, and `ui`.

Commands may define CLI-style `subcommands`; each branch owns its arguments, refinement, form metadata, aliases, and typed handler while inheriting shared root flags. The helper, completion engine, generated help, parser, serializer, and expanded form all switch to the selected branch.

## Documentation

- [`command-definitions`](docs/command-definitions.md)
- [`arguments`](docs/arguments.md)
- [`completions-and-forms`](docs/completions-and-forms.md)
- [`skills`](docs/skills.md)
- [`configuration`](docs/configuration.md)

## License

[MIT](LICENSE)
