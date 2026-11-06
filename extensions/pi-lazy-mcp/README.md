# Pi Lazy MCP

Start MCP servers only when Pi calls their tools. Automatically saved tool catalogs let the model find tools while the servers stay stopped.

- **Start on use:** Connect to a server when its tools are called.
- **Same configuration:** Read the `mcp.json` files Pi's built-in MCP support reads.
- **Same tools:** Expose tools under the same names and through the same `codemode`, `tool_search`, and direct routes.
- **Stop idle servers:** Optionally disconnect servers that are safe to restart.

## Installation

```sh
pi install npm:@zigai/pi-lazy-mcp
```

This replaces Pi's built-in MCP support. Extension-registered MCP servers are ignored with a warning.

## Setup

1. Keep your servers in `~/.pi/agent/mcp.json` and the trusted project's `.pi/mcp.json`. The format, overrides, `${VAR}`/`!command` expansion, and exposure settings match Pi's built-in MCP support, described in Pi's `docs/mcp.md`.
2. Start Pi. A server without a saved tool catalog is discovered once in the background, then stopped. Catalogs are saved in `~/.pi/agent/lazy-mcp-catalogs.json`, one per server name, command, args, and URL.
3. Use the tools. A server starts on its first tool call and stays running until the session ends, or until its idle time passes if you set one below.

For servers that must receive feedback while idle, such as GameOps, set `"eager": ["gameops"]` in the settings below. They connect at session startup even with a saved catalog and stay connected until shutdown. Put their MCP config in `~/.pi/agent/mcp.json` when using them from nested game directories; only the working directory's project config is read.

Run `/mcp` to see server status and errors, and `/mcp discover NAME` to refresh and save one catalog. When a call finds a changed tool definition, the call is rejected, the new catalog is saved, and the model can retry.

Servers using `auth` or `oauth`, and servers answering 401, are not supported. They report an error without affecting other servers. Resource tools such as `list_mcp_resources` are not provided.

<details>
<summary>Full settings reference and example</summary>

<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-lazy-mcp.json`.

| Option  | Type                    | Default | Description                                                                                                                                                                                                       |
| ------- | ----------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eager` | string[]                | `[]`    | Servers to connect at session startup and keep connected for presence and feedback, even before any tool call. Overrides idle eviction for these servers.                                                         |
| `idle`  | Record<string, integer> | `{}`    | Milliseconds of idleness after which to stop a server, by server name. Set only for restart-safe servers; active calls and residency capabilities prevent eviction. Unlisted servers stay connected once started. |

### Defaults

```json
{
  "$schema": "./schemas/pi-lazy-mcp.schema.json",
  "eager": [],
  "idle": {}
}
```

### Advanced example

```json
{
  "$schema": "./schemas/pi-lazy-mcp.schema.json",
  "idle": {
    "sample": 600000
  }
}
```
<!-- pi-extension-settings:end -->

</details>

## License

[MIT](LICENSE)
