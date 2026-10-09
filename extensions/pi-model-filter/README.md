# Pi Model Filter

<a href="https://www.npmjs.com/package/@zigai/pi-model-filter"><img alt="npm version" src="https://img.shields.io/npm/v/@zigai/pi-model-filter.svg?color=blue" style="display:inline-block;border:0" /></a> <a href="https://www.npmjs.com/package/@zigai/pi-model-filter"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@zigai/pi-model-filter.svg" style="display:inline-block;border:0" /></a> <a href="https://github.com/zigai/pi-tweaks/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@zigai/pi-model-filter.svg" style="display:inline-block;border:0" /></a>

Focused model lists for Pi, showing only the models you want.

## Install

```sh
pi install npm:@zigai/pi-model-filter
```

<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-model-filter.json`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `include` | { provider: string; models: string[] }[] | `[]` | Provider and model glob rules that form inclusion allowlists. |
| `exclude` | { provider: string; models: string[] }[] | `[]` | Provider and model glob rules that hide matching models. |

### Defaults

```json
{
  "$schema": "./schemas/pi-model-filter.schema.json",
  "include": [],
  "exclude": []
}
```

### Advanced example

```json
{
  "$schema": "./schemas/pi-model-filter.schema.json",
  "include": [
    {
      "provider": "openai-codex",
      "models": [
        "gpt-5.*"
      ]
    }
  ],
  "exclude": [
    {
      "provider": "openai-codex",
      "models": [
        "*-mini"
      ]
    }
  ]
}
```
<!-- pi-extension-settings:end -->

## Rules

- `provider` and `models` match provider/model ids.
- Exact strings and glob patterns are supported.
- `*` matches any number of characters; `?` matches one character.
- `include` allowlists models for matching providers.
- `exclude` hides matching models and always wins over `include`.
- Providers without `include` rules stay visible unless excluded.
- The same rules apply to chat, image, and classifier catalogs and lookups.

## How is this different from `/scoped-models`?

Pi has a built-in `/scoped-models` command. It shows an interactive checklist that lets you enable or disable individual models for `Ctrl+P` cycling. Changes are session-only until you press `Ctrl+S` to persist them.

`pi-model-filter` works differently:

|                      | `/scoped-models`                     | `pi-model-filter`                                                     |
| -------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| How you configure it | Interactive checklist                | JSON config file with glob patterns                                   |
| What it affects      | `Ctrl+P` model cycling only          | `/model`, `Ctrl+L`, `Ctrl+P` cycling, and `modelRegistry.*()` lookups |
| Persistence          | Optional (save with `Ctrl+S`)        | Always loaded from JSON config                                        |
| Use case             | Quickly narrow the active cycle list | Permanently hide noisy/unwanted models everywhere                     |

## Behavior

This extension filters models from Pi's model registry views, including:

- `/model`
- model cycling
- `modelRegistry.getAll()`
- `modelRegistry.getAvailable()`
- `modelRegistry.find()`
- Typed registry catalogs and lookups (`getModelsOfType`, `getAvailableOfType`, `getModelOfType`, `findOfType`)
- Runtime catalogs and lookups, including typed views, `getAllModels()`, and `getAllAvailable()`

It does not delete provider definitions, model definitions, or credentials.

## License

MIT
