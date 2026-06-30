# Pi Codex Core

Slim Pi-native Codex extras for Pi coding agent.

## Features

- `web_run` — Codex-backed web search via the OpenAI Codex search endpoint. Tool output is compacted into readable source cards, with raw Codex output saved outside the active workspace under `~/.pi/agent/pi-codex-core/web-run/<session>/`.
- `imagegen` — Codex image generation/editing. Images are saved outside the active workspace under `~/.pi/agent/pi-codex-core/imagegen/<session>/` and archived in Codex-style storage under `~/.pi/agent/generated_images/<session>/`.
- `view_image` — native image return for local files, plus optional Codex-backed descriptions.
- `/codex` — Pi-native tabbed settings UI for tools, prompt mode, OpenAI options, usage, and reset spending.
- Optional Codex-style prompt mode using the bundled Codex base prompt.
- Optional Codex remote compaction v2 replay for OpenAI Codex responses models.

Rate-limit reset spending is never automatic and has no `/codex reset` shortcut. Open `/codex`, go to the Usage tab, choose the reset action, and confirm in the UI before the consume endpoint is called.
