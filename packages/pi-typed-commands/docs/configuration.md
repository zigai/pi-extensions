# Configuration and Package Notes

Pi Typed Commands is a library for Pi extensions and typed skills. When a command or skill uses this library, typed parsing, completions, editor hints, and argument forms are always active.

There are no environment variables, command options, or callbacks that disable or bypass those features.

## Live helper placement

The compact live helper is shown above the user input editor by default. Move it below the input editor with Pi settings:

```json
{
  "piTypedCommands": {
    "helperPlacement": "belowEditor"
  }
}
```

Project `.pi/settings.json` overrides global `~/.pi/agent/settings.json` when the project is trusted. Valid values are `"belowEditor"` and `"aboveEditor"`.

You can also pass the option when you compose the extension entrypoint yourself:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installTypedCommandUx } from "pi-typed-commands";

export default function extension(pi: ExtensionAPI): void {
  installTypedCommandUx(pi, { helperPlacement: "belowEditor" });
}
```

Explicit `installTypedCommandUx()` options override Pi settings.

## Global appearance

Presentation is controlled globally from `~/.pi/agent/settings.json` under `piTypedCommands.appearance`. Project settings are intentionally ignored for appearance so all extensions and typed skills share the same command UI.

Command and skill definitions still own local content such as argument descriptions, titles, widgets, defaults, and completion behavior. Global appearance only controls colors, symbols, layout, and helper metadata formatting.

```json
{
  "piTypedCommands": {
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
        }
      }
    }
  }
}
```

Unknown keys, unsupported color names, invalid modes, empty symbols, and out-of-range layout numbers fall back to safe defaults.

### Supported color roles

Appearance colors must use Pi theme roles, not raw ANSI escapes:

`accent`, `border`, `borderAccent`, `borderMuted`, `success`, `error`, `warning`, `muted`, `dim`, `text`, `thinkingText`, `userMessageText`, `customMessageText`, `customMessageLabel`, `toolTitle`, `toolOutput`, `mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`, `mdListBullet`, `toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext`, `syntaxComment`, `syntaxKeyword`, `syntaxFunction`, `syntaxVariable`, `syntaxString`, `syntaxNumber`, `syntaxType`, `syntaxOperator`, `syntaxPunctuation`, `thinkingOff`, `thinkingMinimal`, `thinkingLow`, `thinkingMedium`, `thinkingHigh`, `thinkingXhigh`, `bashMode`.

### Inline helper examples

Compact default-style helper:

```json
{
  "piTypedCommands": {
    "appearance": {
      "inlineHelp": {
        "metadata": { "types": false, "descriptions": false }
      }
    }
  }
}
```

Type-rich helper:

```json
{
  "piTypedCommands": {
    "appearance": {
      "inlineHelp": {
        "metadata": { "types": true, "aliases": true, "descriptions": true },
        "colors": { "type": "syntaxType", "metadata": "muted" }
      }
    }
  }
}
```

### Form customization example

```json
{
  "piTypedCommands": {
    "appearance": {
      "form": {
        "symbols": {
          "focusedField": "»",
          "selectedCheckbox": "☑",
          "unselectedCheckbox": "☐"
        },
        "layout": {
          "leftPadding": 2,
          "fieldGap": 2,
          "descriptions": "focused",
          "instructions": "short"
        }
      }
    }
  }
}
```

### Detailed `--help` metadata

`piTypedCommands.appearance.detailedHelp` can opt into alternate generated help metadata when users run `--help`:

```json
{
  "piTypedCommands": {
    "appearance": {
      "detailedHelp": {
        "order": "required-first",
        "metadata": {
          "types": true,
          "defaults": true,
          "required": true,
          "aliases": true,
          "descriptions": true,
          "enumValues": true
        }
      }
    }
  }
}
```

When `detailedHelp` is omitted, the generated `formatDetailedHelp(command)` output remains the legacy default. Partial `detailedHelp` settings inherit that legacy metadata, so aliases stay hidden unless `metadata.aliases` is explicitly set to `true`.

## Package contract

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
