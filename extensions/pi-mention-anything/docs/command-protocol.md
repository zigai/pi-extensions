# Command sources

Command sources return candidates as JSON. Commands run directly with arguments, without a shell.

| Property                                 | Default                       |
| ---------------------------------------- | ----------------------------- |
| Timeout (`timeoutMs`)                    | 5 seconds                     |
| Combined output limit (`maxOutputBytes`) | 1 MiB                         |
| Standard output                          | One JSON value                |
| Diagnostics                              | Exclude raw stdout and stderr |

## Array mode

Array mode is the default. The command receives no stdin and returns a list of settings items:

```json
[{ "name": "server", "description": "SSH target", "replacement": "SSH host alias server" }]
```

Items may also supply `id`, `segment`, `searchText`, `parentPath` (ancestor IDs), `selectable`, and `navigable`. Simple items default ID and segment to `name`. Array mode uses local filtering and is intended for bounded enumerable collections.

## Protocol mode

`mode: "protocol"` supports search, pagination, and chains. Each invocation receives one newline-terminated JSON request on stdin, followed by EOF, and returns one JSON response.

Example configuration:

```json
{
  "mentions": [
    {
      "id": "tickets",
      "trigger": "ticket:",
      "source": {
        "type": "command",
        "mode": "protocol",
        "command": "node",
        "args": ["/absolute/path/query-command.mjs"],
        "filtering": "provider",
        "cache": true,
        "cacheTtlMs": 30000
      }
    }
  ]
}
```

Discovery request:

```json
{
  "version": 1,
  "method": "discover",
  "sourceId": "tickets",
  "cwd": "/work/project",
  "trusted": true,
  "query": "12",
  "path": [],
  "limit": 100
}
```

Discovery response:

```json
{
  "version": 1,
  "method": "discover",
  "result": {
    "items": [
      {
        "id": "123",
        "label": "Ticket 123",
        "segment": "123",
        "selectable": true,
        "navigable": false,
        "replacement": "issue tracker ticket #123"
      }
    ],
    "nextCursor": "next-page-token"
  }
}
```

Subsequent page requests include `cursor`; the final response omits `nextCursor`. `filtering: "provider"` preserves source ranking.

Chains have a `separator` in the mention definition. Their discovery `path` contains selected ancestors, including stable IDs and optional JSON data.

Exact resolution request:

```json
{
  "version": 1,
  "method": "resolve",
  "sourceId": "tickets",
  "cwd": "/work/project",
  "trusted": true,
  "segments": ["123"]
}
```

Resolution responses use the same version and method envelope. A resolved `result` contains `status: "resolved"`, the candidate `path` from root to target, and an optional whole-target `replacement`. An unresolved result contains `status: "unresolved"` and a reason, such as `"missing"`.

Exact resolution works independently of previously loaded pages.

Reference: [query command example](../examples/query-command.mjs), `CommandRequestV1`, and `CommandResponseV1`.
