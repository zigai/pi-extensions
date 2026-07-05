# Configuration

Pi Typed Commands is a library for Pi extensions and typed skills. Typed parsing, completions, editor hints, and argument forms are active for commands and skills that use it.

Use global config at `~/.pi/agent/pi-typed-commands/config.json`.

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

## Package Notes

Current package characteristics:

- distributed as a Git dependency until the first npm publication;
- ESM package with TypeScript source exports;
- tested with `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` `^0.79.7`;
- public subpaths for core, Pi adapter, skills, TUI integration, and JSON Schema.

Because Pi can load TypeScript extension packages directly, source exports are sufficient for Pi usage. Define commands once and register the definition or defined command with Pi:

```ts
const command = defineTypedCommand(...);
registerTypedCommand(pi, command);
```
