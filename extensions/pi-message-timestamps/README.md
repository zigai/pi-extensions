# Pi Message Timestamps

Show timestamps on user and assistant messages. With the `first-line` placement, assistant messages reserve timestamp space while streaming, so completion does not re-wrap the text. User text wraps when needed to make room. Assistant timestamps show completion time; restored messages use their saved entry time.

```sh
pi install npm:@zigai/pi-message-timestamps
```

<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-message-timestamps.json`.

| Option               | Type                                               | Default        | Description                                                                                                                                                                                                       |
| -------------------- | -------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`            | boolean                                            | `true`         | Show timestamps on messages.                                                                                                                                                                                      |
| `format`             | `auto` \| `time-only` \| `date-time` \| `relative` | `"auto"`       | Timestamp format: auto shows time today and date and time on other days; time-only, date-time, or relative always use that format.                                                                                |
| `assistantPlacement` | `first-line` \| `last-line` \| `below`             | `"first-line"` | Where response timestamps appear: first-line puts the time right of the first line; last-line puts it right of the last line; below adds a blank line and then a line with the time, model, duration, and tokens. |

```json
{
  "$schema": "./schemas/pi-message-timestamps.schema.json",
  "enabled": true,
  "format": "auto",
  "assistantPlacement": "first-line"
}
```
<!-- pi-extension-settings:end -->
