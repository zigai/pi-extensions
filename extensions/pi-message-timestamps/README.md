# Pi Message Timestamps

Show timestamps on user and assistant messages without adding lines. Assistant timestamps show completion time; restored messages use their saved entry time.

```sh
pi install npm:@zigai/pi-message-timestamps
```

<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-message-timestamps.json`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Show timestamps on messages. |
| `format` | `auto` \| `time-only` \| `date-time` \| `relative` | `"auto"` | Timestamp format: auto shows time today and date and time on other days; time-only, date-time, or relative always use that format. |

```json
{
  "$schema": "./schemas/pi-message-timestamps.schema.json",
  "enabled": true,
  "format": "auto"
}
```
<!-- pi-extension-settings:end -->
