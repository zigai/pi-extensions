# Pi Workspace — chat history and sidebar

Customize Pi's terminal interface with conversation details and a session sidebar. Search saved messages and tool output across branches without switching your current branch.

- **Conversation details:** Show message identities and optional timestamps beside the chat.
- **Session sidebar:** Keep the project path, session, and activity status visible.
- **History search:** Read saved content from other branches without changing the active conversation.

## Installation

```sh
pi install npm:@zigai/pi-workspace
```

Requires Pi 1.3 or newer. Workspace changes are disabled by default.

## Quick start

Show message details beside the conversation in Pi:

```text
/workspace-on
/workspace-transcript ledger
```

Other commands change individual parts of the interface:

| Command | Result |
| --- | --- |
| `/workspace-transcript ledger` | Show message identities beside the conversation. |
| `/workspace-sidebar right` | Add a session sidebar; requires Pi's full-screen mode. |
| `/history-search error` | Search saved messages and tool output for “error”. |
| `/workspace-transcript native` | Return to Pi's standard conversation view. |
| `/workspace-sidebar off` | Hide the sidebar. |
| `/workspace-off` | Restore the interface from before activation. |

These choices apply to the current session. Set `enabled` to `true` and choose `transcript` and `layout` below to use them in future sessions.

<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-workspace.json`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Enable the replaceable workspace surface. |
| `transcript` | string | `"native"` | Transcript backend: native, ledger, or a registered name. |
| `editor` | string | `"native"` | Editor backend: native or a registered name. |
| `layout` | string | `"native"` | Layout backend: native, sidebar, or a registered name. |
| `sidebarSide` | `off` \| `left` \| `right` | `"off"` | Optional persistent sidebar position. |
| `sidebarWidth` | integer | `24` | Sidebar width in terminal columns. |
| `minimumMainWidth` | integer | `48` | Main-area width below which the sidebar is hidden. |
| `timestamps` | boolean | `false` | Show available message and tool timestamps in ledger metadata. |
| `durations` | boolean | `false` | Show observed tool duration when both execution boundaries were available. |
| `timeouts` | boolean | `false` | Show available tool timeout arguments in ledger metadata. |

```json
{
  "$schema": "./schemas/pi-workspace.schema.json",
  "enabled": false,
  "transcript": "native",
  "editor": "native",
  "layout": "native",
  "sidebarSide": "off",
  "sidebarWidth": 24,
  "minimumMainWidth": 48,
  "timestamps": false,
  "durations": false,
  "timeouts": false
}
```
<!-- pi-extension-settings:end -->

## License

[MIT](../../LICENSE)
