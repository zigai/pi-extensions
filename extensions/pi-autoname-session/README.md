# Pi Autoname Session

Automatically name new Pi sessions

## Install

```sh
pi install git:github.com/my-user/pi-autoname-session
```

For this private package on this machine, load the local working copy from Pi settings:

```json
{
  "packages": ["/home/zigai/Projects/pi-autoname-session"]
}
```

## Extension

The Pi extension entrypoint in `src/index.ts` loads and validates extension settings at session start.
<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-autoname-session.json`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Enable the extension. |

```json
{
  "$schema": "./schemas/pi-autoname-session.schema.json",
  "enabled": true
}
```
<!-- pi-extension-settings:end -->

## Development

```sh
just setup
just coverage
```
