# Pi Lazy MCP

Start MCP servers only when Pi calls their tools. Saved tool catalogs let the model find tools while the servers stay stopped.

- **Start on use:** Connect to a server when its tools are called.
- **Find tools:** Make saved tool descriptions available to Pi's tool search.
- **Stop idle servers:** Optionally disconnect servers that are safe to restart.

## Installation

```sh
pi install npm:@zigai/pi-lazy-mcp
```

This replaces Pi's built-in MCP connections. Move server settings from `mcp.json` into this extension's settings; other MCP replacements and extension-registered servers cannot run alongside it.

## Quick start

1. Add a server and its tool catalog to `~/.pi/agent/extension-settings/pi-lazy-mcp.json`. Expand the settings reference below for an example.
2. Start a new Pi session. Ask Pi to use one of the configured tools; its server connects on the first call.
3. Run `/mcp` to see connection status. Use `/mcp discover NAME` to connect and fetch a fresh catalog, then copy it into settings for future sessions.

For `deferred` or `codemode` exposure, enable Pi's `tool_search` or `codemode` tool, respectively. Changed server tool definitions reject the old call and refresh the session catalog.

Credential settings name environment variables containing the secrets. Stdio servers receive only the configured environment. HTTP uses the authentication headers you configure.

<details>
<summary>Full settings reference and example</summary>

<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-lazy-mcp.json`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `servers` | [LazyServer](#settings-type-LazyServer)[] | `[]` | Owned servers and supplied catalogs. This extension replaces native session MCP; use /mcp discover NAME to explicitly refresh one catalog. |

### Defaults

```json
{
  "$schema": "./schemas/pi-lazy-mcp.schema.json",
  "servers": []
}
```

### Advanced example

```json
{
  "$schema": "./schemas/pi-lazy-mcp.schema.json",
  "servers": [
    {
      "name": "sample",
      "description": "Sample lookups",
      "exposure": "deferred",
      "transport": {
        "type": "stdio",
        "command": "sample-mcp",
        "args": [],
        "cwd": ".",
        "env": {}
      },
      "catalog": {
        "tools": [
          {
            "name": "lookup",
            "description": "Look up a sample entry",
            "inputSchema": {
              "type": "object",
              "properties": {
                "key": {
                  "type": "string"
                }
              },
              "required": [
                "key"
              ]
            }
          }
        ]
      }
    }
  ]
}
```

### Structural types

<a id="settings-type-LazyServer"></a>

#### LazyServer

Additional fields are not allowed.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes |  |
| `description` | string | Yes |  |
| `transport` | [StdioServer](#settings-type-StdioServer) \| [HttpServer](#settings-type-HttpServer) | Yes |  |
| `catalog` | [ToolCatalog](#settings-type-ToolCatalog) | Yes |  |
| `exposure` | `direct` \| `codemode` \| `deferred` \| `hidden` | Yes | Pi tool exposure; discovery uses supplied metadata without connecting. |
| `idle` | [IdlePolicy](#settings-type-IdlePolicy) | No |  |

<a id="settings-type-StdioServer"></a>

#### StdioServer

Additional fields are not allowed.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `stdio` | Yes |  |
| `command` | string | Yes |  |
| `args` | string[] | Yes |  |
| `cwd` | string | Yes | Working directory, relative to the session root or absolute. |
| `env` | Record<string, string> | Yes | Environment variable bindings: destination name to source variable name. Values are never persisted credentials. |

<a id="settings-type-HttpServer"></a>

#### HttpServer

Additional fields are not allowed.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `http` | Yes |  |
| `url` | string | Yes | Streamable HTTP endpoint without embedded credentials. |
| `headers` | Record<string, string> | Yes | Environment variable bindings: destination name to source variable name. Values are never persisted credentials. |

<a id="settings-type-ToolCatalog"></a>

#### ToolCatalog

Additional fields are not allowed.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `instructions` | string | No |  |
| `tools` | [CatalogTool](#settings-type-CatalogTool)[] | Yes |  |

<a id="settings-type-IdlePolicy"></a>

#### IdlePolicy

Additional fields are not allowed.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `afterMs` | integer | Yes | Disconnect after this idle duration. Set only for restart-safe servers; active calls and residency capabilities prevent eviction. |

<a id="settings-type-CatalogTool"></a>

#### CatalogTool

Additional fields are not allowed.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes |  |
| `title` | string | No |  |
| `description` | string | No |  |
| `inputSchema` | [JsonObject](#settings-type-JsonObject) | Yes |  |
| `outputSchema` | [JsonObject](#settings-type-JsonObject) | No |  |
| `annotations` | { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean } | No |  |
| `execution` | { taskSupport?: `forbidden` \| `optional` \| `required` } | No |  |
| `_meta` | [JsonObject](#settings-type-JsonObject) | No |  |

<a id="settings-type-JsonObject"></a>

#### JsonObject

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `^.*$` | Json | No |  |
<!-- pi-extension-settings:end -->

</details>

## License

[MIT](LICENSE)
