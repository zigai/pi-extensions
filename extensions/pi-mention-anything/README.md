# Pi Mention Anything

Custom mention pickers for Pi, from simple lists to chained selections. Available through settings and a TypeScript API.

## Install

```sh
pi install npm:@zigai/pi-mention-anything
```

Selections become mentions in the editor and expand into context for the model. Chained selections open successive pickers.

<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-mention-anything.json`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mentions` | MentionDefinition[] | `[]` | Mention sources enabled in Pi. |

### Defaults

```json
{
  "$schema": "./schemas/pi-mention-anything.schema.json",
  "mentions": []
}
```

### Advanced example

```json
{
  "$schema": "./schemas/pi-mention-anything.schema.json",
  "mentions": [
    {
      "id": "environments",
      "trigger": "%",
      "completionSuffix": " ",
      "source": {
        "type": "static",
        "items": [
          {
            "name": "staging",
            "description": "Staging environment"
          },
          {
            "name": "production",
            "description": "Production environment"
          }
        ]
      },
      "initialSuggestions": {
        "strategy": "frecency",
        "pinned": []
      }
    },
    {
      "id": "tickets",
      "trigger": "ticket:",
      "completionSuffix": " ",
      "source": {
        "type": "command",
        "mode": "array",
        "command": "list-my-tickets",
        "args": [
          "--json"
        ],
        "cache": true,
        "refreshOnStartup": true,
        "cacheTtlMs": 300000
      },
      "initialSuggestions": {
        "strategy": "frecency",
        "pinned": []
      }
    }
  ]
}
```
<!-- pi-extension-settings:end -->

## TypeScript API

`registerMention` connects a provider to Pi’s pickers and context expansion:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createListProvider, registerMention } from "@zigai/pi-mention-anything/api";

export default function (pi: ExtensionAPI): void {
  registerMention(pi, {
    id: "environments",
    configuration: () => ({ trigger: "%" }),
    provider: () => createListProvider(async () => [
      { id: "staging", label: "Staging", segment: "staging", selectable: true, navigable: false, replacement: "environment:staging" },
      { id: "production", label: "Production", segment: "production", selectable: true, navigable: false, replacement: "environment:production" },
    ]),
  });
}
```

## Documentation

- [Provider contracts, chained navigation, and cache options](docs/providers.md)
- [Versioned command protocol](docs/command-protocol.md)
- [Example: Recursive tree](examples/recursive-tree.ts)
- [Example: tmux sessions, windows, and panes](examples/tmux.ts)

## License

[MIT](../../LICENSE)
