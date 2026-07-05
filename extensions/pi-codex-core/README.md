# Pi Codex Core

Slim Pi-native Codex extras for Pi coding agent.

## Features

- `web_run` — Codex-backed web search via the OpenAI Codex search endpoint. Tool output is compacted into readable source cards, with raw Codex output saved outside the active workspace under `~/.pi/agent/pi-codex-core/web-run/<session>/`.
- `imagegen` — Codex image generation/editing. Images are saved outside the active workspace under `~/.pi/agent/pi-codex-core/imagegen/<session>/`, with `latest.png` kept in that artifact directory.
- `view_image` — native image return for local files, plus optional Codex-backed descriptions.
- `apply_patch` — optional TypeScript port of the Codex native apply_patch edit tool. When enabled, it replaces Pi's native `edit` tool.
- `/codex` — Pi-native tabbed settings UI for tools, prompt mode, OpenAI options, usage, reset expiration, and reset spending.
- Optional Codex-style prompt mode using the bundled Codex base prompt.
- Optional Codex remote compaction v2 replay for OpenAI Codex responses models, with chaining, metadata, fallbacks, world-state injection, auto-compaction, and token-aware shrinking.

## Configuration

Use global config at `~/.pi/agent/pi-codex-core/config.json`.

| Option                         | Default         | Purpose                                                                                  |
| ------------------------------ | --------------- | ---------------------------------------------------------------------------------------- |
| `scope.tools`                  | `"codex"`       | Show Codex tools only for Codex-like models; use `"all"` to expose them for every model. |
| `tools.webSearch`              | `true`          | Enable the `web_run` search tool.                                                        |
| `tools.imageGeneration`        | `true`          | Enable the `imagegen` generation/editing tool.                                           |
| `tools.viewImage`              | `true`          | Enable local image viewing.                                                              |
| `tools.viewImageDescriptions`  | `false`         | Add Codex-generated descriptions when viewing images.                                    |
| `tools.applyPatch`             | `"off"`         | Use `apply_patch` instead of `edit`: `"off"`, `"openai"`, or `"all"`.                    |
| `prompt.mode`                  | `"pi"`          | Use Pi's normal prompt; use `"codex"` for the bundled Codex-style prompt.                |
| `compaction.enabled`           | `false`         | Enable Codex-style conversation compaction.                                              |
| `compaction.auto`              | `true`          | Automatically compact when token usage reaches the threshold.                            |
| `compaction.thresholdPercent`  | `80`            | Token usage percentage that triggers auto-compaction.                                    |
| `openai.webSearchModel`        | `"current"`     | Model for `web_run`; `"current"` uses the active Codex model.                            |
| `openai.imageModel`            | `"gpt-image-2"` | Model for `imagegen`.                                                                    |
| `openai.imageDescriptionModel` | `"current"`     | Model for image descriptions; `"current"` uses the active Codex model.                   |
| `openai.compactionModel`       | `"current"`     | Model for compaction; `"current"` uses the active Codex model.                           |
| `openai.compactionReasoning`   | `"medium"`      | Reasoning level for compaction requests.                                                 |
| `openai.verbosity`             | `"low"`         | Verbosity for Codex-backed requests.                                                     |
| `openai.fast`                  | `false`         | Prefer faster/lower-latency Codex request behavior when available.                       |

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
    "mode": "pi"
  },
  "compaction": {
    "enabled": false,
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
    "fast": false
  }
}
```
