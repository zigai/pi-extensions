# @zigai/pi-message-highlights

Highlights URLs and file paths in Pi's interactive UI:

- URLs render in a configurable blue foreground by default.
- File paths render with Pi's accent/highlight color.
- Applies to assistant responses, past user messages, and the prompt editor.

## Install

```sh
pi install npm:@zigai/pi-message-highlights
```

<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-message-highlights.json`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `urlColor` | integer \| string | `"#87d7ff"` | URL color as an ANSI-256 index, hex color, theme color name, or empty string to disable highlighting. |

```json
{
  "$schema": "./schemas/pi-message-highlights.schema.json",
  "urlColor": "#87d7ff"
}
```
<!-- pi-extension-settings:end -->

## License

MIT
