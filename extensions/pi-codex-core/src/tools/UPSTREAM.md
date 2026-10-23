# Upstream Codex Tools

The model-facing Codex tool assets and applicable default behavior in this directory are pinned against OpenAI Codex tag `rust-v0.153.4`, commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` (2026-09-04).

- `web-run/web-run-description.md`: `codex-rs/ext/web-search/web_run_description.md`, source SHA-256 `1f3879b44690eb7aad9ba97351acda16c4d0c26847bcb4af2964d5989404407e`. Runtime adaptation changes `web.run` to Pi's flat `web_run` name.
- `imagegen-description.md`: `codex-rs/ext/image-generation/imagegen_description.md`, tag `rust-v0.163.0`, commit `83086188ae0614bd882818ff1aa23f3194962012` (2026-10-15), source SHA-256 `ee89dd3b9df94cc8b42b14e48714c68d11d4cd66113853b42ccf9cbd7858af61`. Runtime adaptation replaces Codex tool names and code-mode waiting instructions with Pi guidance. Explicit `transparent_background` follows upstream; omission keeps Pi's `auto` background instead of upstream's opaque default.
- `view-image/tool.ts`: schema and behavior track `codex-rs/core/src/tools/handlers/view_image_spec.rs` and `view_image.rs`, with Pi's optional text-model description fallback.
- `apply-patch/`: parser and patch language track `codex-rs/apply-patch` and the freeform tool contract, projected through Pi's function-tool argument. Pi additionally preflights the whole patch, participates in the shared file-mutation queue, and rejects stale concurrent writes instead of leaving upstream-style partial mutations after a later hunk fails.

Pi projects Codex namespace/code-mode tools as flat direct Pi tools because Pi does not expose Codex's nested code-mode runtime. It keeps native renderers and optional Glowup protocol adapters alongside the model-facing contracts.

The recorded `web_run` description and `apply_patch` freeform specification remain unchanged through v0.153.4. Patch line-ending preservation now follows v0.163.0's unconditional behavior in `codex-rs/apply-patch/src/file_update.rs` and `text_file.rs` at commit `83086188ae0614bd882818ff1aa23f3194962012`. Pi keeps its `view_image.detail` contract and rejects invalid image data before returning output.

Standalone `web_run` deliberately defaults to `live`. Codex v0.150.1 stores `cached` as its base preference but resolves eligible turns with `PermissionProfile::Disabled` (no outer sandbox) to `live`; Pi has no equivalent per-turn permission-profile resolver. Search result formatting removes internal citation markers while retaining explicit URLs, matching the upstream instruction that internal reference IDs stay inside tool calls and final answers cite Markdown links.
