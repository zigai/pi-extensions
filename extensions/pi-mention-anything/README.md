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
| `mentions` | [MentionDefinition](#settings-type-MentionDefinition)[] | `[]` | Mention sources enabled in Pi. |

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

### Structural types

<a id="settings-type-MentionDefinition"></a>

#### MentionDefinition

Additional fields are not allowed.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Stable identifier used for diagnostics and selection history. |
| `trigger` | string | Yes | One or more non-whitespace, non-slash characters that start the mention. |
| `separator` | string | No | Separator between chained mention segments. |
| `expansionPolicy` | `selected-only` \| `selected-or-resolved` | No | Expand only picker selections, or also resolve manually typed mentions. |
| `replacementTemplate` | string | No | Replacement template. Allowed fields: {{id}}, {{label}}, {{segment}}, {{path}}, {{ids}}. Provider data is never implicitly included. |
| `completionSuffix` | string | No | Text inserted after a completed mention. |
| `source` | [StaticMentionSource](#settings-type-StaticMentionSource) \| [CommandMentionSource](#settings-type-CommandMentionSource) | Yes | Where this mention gets its candidates. |
| `initialSuggestions` | { strategy: `frecency` \| `recent` \| `frequent` \| `alphabetical` \| `sourceOrder`; pinned: string[] } | No | Controls the entries shown immediately after the trigger. |

<a id="settings-type-StaticMentionSource"></a>

#### StaticMentionSource

Additional fields are not allowed.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `static` | Yes |  |
| `items` | [MentionItem](#settings-type-MentionItem)[] | Yes | Candidates offered by this mention source. |

<a id="settings-type-CommandMentionSource"></a>

#### CommandMentionSource

Additional fields are not allowed.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `command` | Yes |  |
| `mode` | `array` \| `protocol` | No | array prints a flat item array; protocol uses version 1 JSON requests on stdin for discovery and exact resolution. |
| `filtering` | `local` \| `provider` | No | Protocol result ranking owner. Array commands always use local filtering. |
| `maxOutputBytes` | integer | No | Maximum combined standard output and standard error size in bytes. |
| `refreshIntervalMs` | integer | No | Periodic refresh interval for active cache entries. Requires caching. |
| `watchFiles` | string[] | No | Files whose changes invalidate cached results. Requires caching. |
| `persistentCache` | boolean | No | Local disk caching, scoped by configuration, working directory, and trust. |
| `command` | string | Yes | Executable that returns candidates in the selected command mode. |
| `args` | string[] | Yes | Arguments passed directly to the executable without shell interpretation. |
| `debounceMs` | integer | No | Delay before starting the command so superseded autocomplete requests can cancel. |
| `timeoutMs` | integer | No | Maximum command runtime in milliseconds. |
| `refreshOnStartup` | boolean | No | Background root discovery at session startup. Requires caching. |
| `cacheTtlMs` | integer | No | Cache lifetime in milliseconds. Expired results remain available during refresh. Without a lifetime, results last for the session. |
| `cache` | boolean | No | Caching of successful command results. |

<a id="settings-type-MentionItem"></a>

#### MentionItem

Additional fields are not allowed.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Name selected and written after the trigger. |
| `id` | string | No | Stable identity within the parent path. Defaults to name for simple lists. |
| `segment` | string | No | Text inserted as this path segment. Defaults to name. |
| `searchText` | string | No | Text used for searching instead of the name and description. |
| `insertionText` | string | No | Complete editor text for a selected terminal target. |
| `parentPath` | string[] | No | Ancestor IDs, from root to parent. Omit for root items. |
| `selectable` | boolean | No | Allow selecting this item as a completed target. Defaults to false for navigable items and true otherwise. |
| `navigable` | boolean | No | Open a child picker when this item is selected. Defaults to false. |
| `description` | string | No | Secondary text shown in autocomplete. |
| `replacement` | string | No | Text sent to the model in place of the mention. Defaults to the name. |
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
