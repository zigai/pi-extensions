# Pi Codex Core

Everything GPT models need to feel at home in Pi.

## Features

### Tools

- `web_run` — Codex-backed web search via the OpenAI Codex search endpoint.
- `imagegen` — Codex image generation/editing.
- `view_image` — native image return for local files.
- `apply_patch` — optional port of the Codex native `apply_patch` edit tool. If enabled, it replaces Pi's native `edit` tool.

### System Prompt

Model-aware Codex prompt mode uses the matching bundled GPT-5.6 Sol/Terra/Luna or GPT-5.5 system prompt, adapted to Pi's active tools and runtime context.

### Compaction

Optional Codex remote compaction v2 replay supports OpenAI Codex responses models, with chaining, metadata, fallbacks, world-state injection, auto-compaction, and token-aware shrinking.

### `/codex` Slash Command

- Configure extension settings through a dedicated settings UI.
- View current usage and reset expiration dates.
- Activate available usage resets.

### Other

- GPT-5.6 Responses Lite compatibility for ordinary Pi turns, image descriptions, and native compaction.
- Optional GPT-only reasoning trace suppression without disabling hidden model reasoning.

## Configuration

Use global config at `~/.pi/agent/pi-codex-core/config.json`.

| Option                         | Default         | Purpose                                                                                      |
| ------------------------------ | --------------- | -------------------------------------------------------------------------------------------- |
| `scope.tools`                  | `"codex"`       | Show Codex tools only for Codex-like models; use `"all"` to expose them for every model.     |
| `tools.webSearch`              | `true`          | Enable the `web_run` search tool.                                                            |
| `tools.imageGeneration`        | `true`          | Enable the `imagegen` generation/editing tool.                                               |
| `tools.viewImage`              | `true`          | Enable local image viewing.                                                                  |
| `tools.viewImageDescriptions`  | `false`         | Add Codex-generated descriptions when viewing images.                                        |
| `tools.applyPatch`             | `"off"`         | Use `apply_patch` instead of `edit`: `"off"`, `"openai"`, or `"all"`.                        |
| `prompt.mode`                  | `"codex"`       | Use model-aware Codex prompts on GPT models; use `"pi"` for Pi's normal prompt.              |
| `prompt.personality`           | `"pragmatic"`   | Codex communication style: `"friendly"`, `"pragmatic"`, or `"none"`; currently GPT-5.5 only. |
| `compaction.enabled`           | `true`          | Enable Codex-style conversation compaction.                                                  |
| `compaction.auto`              | `true`          | Automatically compact when token usage reaches the threshold.                                |
| `compaction.thresholdPercent`  | `80`            | Token usage percentage that triggers auto-compaction.                                        |
| `openai.webSearchModel`        | `"current"`     | Model for `web_run`; `"current"` uses the active Codex model.                                |
| `openai.imageModel`            | `"gpt-image-2"` | Model for `imagegen`.                                                                        |
| `openai.imageDescriptionModel` | `"current"`     | Model for image descriptions; `"current"` uses the active Codex model.                       |
| `openai.compactionModel`       | `"current"`     | Model for compaction; `"current"` uses the active Codex model.                               |
| `openai.compactionReasoning`   | `"medium"`      | Model-supported reasoning effort; also accepts `"current"`, `"max"`, and `"ultra"`.          |
| `openai.verbosity`             | `"low"`         | Verbosity for Codex-backed requests.                                                         |
| `openai.fast`                  | `false`         | Use up to 1.5× faster token velocity; credit usage varies by model and current pricing.      |
| `openai.showReasoningTraces`   | `true`          | Show streamed reasoning summaries for GPT Responses models.                                  |

```json
{
  "$schema": "./config.schema.json",
  "scope": {
    "tools": "codex"
  },
  "tools": {
    "webSearch": true,
    "imageGeneration": true,
    "viewImage": true,
    "viewImageDescriptions": false,
    "applyPatch": "off"
  },
  "prompt": {
    "mode": "codex",
    "personality": "pragmatic"
  },
  "compaction": {
    "enabled": true,
    "auto": true,
    "thresholdPercent": 80
  },
  "openai": {
    "webSearchModel": "current",
    "imageModel": "gpt-image-2",
    "imageDescriptionModel": "current",
    "compactionModel": "current",
    "compactionReasoning": "medium",
    "verbosity": "low",
    "fast": false,
    "showReasoningTraces": true
  }
}
```

## License

MIT
