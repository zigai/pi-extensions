# Pi Model Alias

<a href="https://www.npmjs.com/package/@zigai/pi-model-alias"><img alt="npm version" src="https://img.shields.io/npm/v/@zigai/pi-model-alias.svg?color=blue" style="display:inline-block;border:0" /></a> <a href="https://www.npmjs.com/package/@zigai/pi-model-alias"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@zigai/pi-model-alias.svg" style="display:inline-block;border:0" /></a> <a href="https://github.com/zigai/pi-tweaks/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@zigai/pi-model-alias.svg" style="display:inline-block;border:0" /></a>

Shorter local model IDs and customizable model and provider labels for Pi.

A model alias maps a provider's real `model` ID to the shorter `alias` accepted by Pi. Its optional `name` changes only the displayed label; omitting it preserves Pi's native model name. Pi keeps alias IDs and labels locally, resolves native IDs before virtual routing, and sends physical model IDs to providers. Provider aliases change displayed provider names without changing provider IDs.

## Install

```sh
pi install npm:@zigai/pi-model-alias
```

<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-model-alias.json`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `aliases` | { provider: string; model: string; alias: string; name?: string }[] | `[]` | Short model IDs with optional display-name overrides. |
| `providerAliases` | { provider: string; name: string }[] | `[]` | Provider display-name overrides; provider IDs remain unchanged. |
| `stableProviderColumn` | boolean | `true` | Keep the provider column stable when aliases are displayed. |

### Defaults

```json
{
  "$schema": "./schemas/pi-model-alias.schema.json",
  "aliases": [],
  "providerAliases": [],
  "stableProviderColumn": true
}
```

### Advanced example

```json
{
  "$schema": "./schemas/pi-model-alias.schema.json",
  "aliases": [
    {
      "provider": "anthropic",
      "model": "claude-sonnet-4-5",
      "alias": "sonnet",
      "name": "Claude Sonnet 4.5"
    },
    {
      "provider": "openai-codex",
      "model": "gpt-5.6-sol",
      "alias": "sol"
    }
  ],
  "providerAliases": [
    {
      "provider": "openai-codex",
      "name": "Codex"
    }
  ]
}
```
<!-- pi-extension-settings:end -->

## License

MIT
