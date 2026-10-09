# Mention providers

Providers supply candidates and resolve targets. The shared engine handles pickers, caching, selection history, and context expansion.

```ts
import { createListProvider, registerMention } from "@zigai/pi-mention-anything/api";

registerMention(pi, {
  id: "environments",
  configuration: () => ({ trigger: "env:", cache: true }),
  provider: () =>
    createListProvider(async () => [
      {
        id: "staging",
        label: "Staging",
        segment: "staging",
        selectable: true,
        navigable: false,
        replacement: "deployment environment staging",
      },
    ]),
});
```

## Candidates

| Field           | Meaning                                            |
| --------------- | -------------------------------------------------- |
| `id`            | Stable identity within the source and parent path  |
| `label`         | Picker label                                       |
| `segment`       | Text inserted into the mention path                |
| `selectable`    | Can be selected as a completed target              |
| `navigable`     | Has a child picker                                 |
| `description`   | Optional secondary picker text                     |
| `searchText`    | Optional search text                               |
| `data`          | Optional JSON data passed to child requests        |
| `replacement`   | Optional text sent to the model                    |
| `insertionText` | Optional replacement for the entire editor mention |

Duplicate IDs within a response are invalid. Labels and segments can repeat; manually typed ambiguous segments remain unresolved. Picker selections retain the chosen ID. Provider data is separate from model context.

## Chains

`separator` enables chained selections. Branches open child pickers; leaves complete the mention with `completionSuffix`, which defaults to one space. Selectable branches also have a **Use this target** row.

Segments support independent quoting and escaping. Changing a parent removes its descendants when a new candidate is selected. Escape closes the popup and leaves the text intact.

## Provider interface

| Member              | Contract                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `filtering`         | `local` for engine fuzzy matching; `provider` for source-owned search and ranking          |
| `discover(request)` | Returns `{ items, nextCursor? }`                                                           |
| `resolve(request)`  | Returns `{ status: "resolved", path, replacement? }` or `{ status: "unresolved", reason }` |
| `dispose()`         | Optional cleanup, synchronous or asynchronous; awaited once at disposal                    |

Discovery requests contain `sourceId`, `cwd`, `trusted`, `query`, resolved ancestor `path`, `limit`, optional `cursor`, and `signal`. Resolution requests contain the same scope, `segments`, and `signal`. The signal covers cancellable provider I/O.

Exact resolution is independent of discovery pages. A parent can resolve for navigation without being selectable. Only selectable targets expand into context.

Local results use fuzzy matching and selection history. Provider-ranked results retain their order. **More…** loads the next page without changing the mention.

`createListProvider` adapts small enumerable lists and trees. It resolves each level by an unambiguous segment match. Larger sources can provide direct lookup through `resolve`.

## Expansion

| Policy                           | Behavior                                               |
| -------------------------------- | ------------------------------------------------------ |
| `selected-or-resolved` (default) | Picker selections and resolvable typed mentions expand |
| `selected-only`                  | Only picker selections expand                          |

Incomplete and unresolved mentions remain literal. Selected targets retain their identity through refreshes. A whole chain expands once; replacement text is not interpreted as further mentions. Resolved submissions remain stable across retries and context rebuilds.

Replacement precedence:

1. Registration callback: `replacement(path, ctx, { signal })`
2. `replacementTemplate`
3. Exact-resolution replacement
4. Candidate replacement
5. Segment text

Templates accept `{{id}}`, `{{label}}`, `{{segment}}`, `{{path}}`, and `{{ids}}`. Unknown fields are invalid. Templates substitute these fields only, without evaluating code or traversing provider data.

## Cache options

These options belong to the API's `configuration` result or a settings command source.

| Option                                                    | Default                              | Behavior                                                        |
| --------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------- |
| `cache`                                                   | `false`                              | Reuse of successful discovery results                           |
| `cacheTtlMs`                                              | None                                 | Cache lifetime; expired results remain available during refresh |
| `refreshOnStartup`                                        | `false`                              | Background root discovery at startup; requires caching          |
| `refreshIntervalMs`                                       | None                                 | Periodic refresh of active entries; requires caching            |
| `watchFiles`                                              | None                                 | File changes invalidate cached results; requires caching        |
| `persistentCachePath` (API), `persistentCache` (settings) | None / `false`                       | Local disk cache scoped by configuration, cwd, and trust        |
| `debounceMs`                                              | `0` (API), `100` (settings commands) | Delay before discovery starts                                   |
| `maxEntries` (API)                                        | `64`                                 | Retained cache scopes                                           |
| `maxConcurrent` (API)                                     | `4`                                  | Concurrent requests per source                                  |

Cache entries distinguish parent IDs, provider-owned queries, and page cursors. Equivalent requests share work. Cancelling one caller leaves other callers active. Failed refreshes preserve the previous results, including empty lists. Disposal cancels work and closes timers and watchers.

Persistent API caches require a `configurationKey` that changes with the source configuration. Settings sources calculate this key automatically.

## Limits

| Resource                      | Limit                                             |
| ----------------------------- | ------------------------------------------------- |
| Provider-ranked page          | 100 candidates                                    |
| Local response                | 10,000 candidates; searched before display limits |
| Picker paging scope           | 10 pages / 1,000 candidates                       |
| Retained paging scopes        | 32                                                |
| Selected branch continuations | 64                                                |
| Path                          | 64 segments                                       |
| Candidate ID                  | 4,096 characters                                  |
| Display/search field          | 16,384 characters                                 |
| Literal replacement           | 1 MiB                                             |
| Persistent cache file         | 8 MiB                                             |

## Examples

- [Static values](../examples/static.ts)
- [Declarative tree settings](../examples/tree-settings.json)
- [Recursive tree](../examples/recursive-tree.ts)
- [tmux sessions, windows, and panes](../examples/tmux.ts)
- [Query and pagination command](../examples/query-command.mjs)
- [Command protocol](command-protocol.md)

TypeScript examples run with `pi -e ./example.ts`.
