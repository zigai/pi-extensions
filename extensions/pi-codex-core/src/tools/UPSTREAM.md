# Upstream Codex Tools

The model-facing Codex tool assets and applicable default behavior in this directory are pinned against OpenAI Codex tag `rust-v0.150.1`, commit `90854393966b21e9ebfd21b122334eb09a20c93d` (2026-08-27).

- `web-run/web-run-description.md`: `codex-rs/ext/web-search/web_run_description.md`, source SHA-256 `1f3879b44690eb7aad9ba97351acda16c4d0c26847bcb4af2964d5989404407e`. Runtime adaptation changes `web.run` to Pi's flat `web_run` name.
- `imagegen-description.md`: `codex-rs/ext/image-generation/imagegen_description.md`, source SHA-256 `77a992a7c90e45fcd11623a1efa34bfd4c7870697e0aa54ce9b28f690877170e`. Runtime adaptation changes `image_gen.imagegen` to `imagegen` and replaces Codex code-mode-only waiting instructions with Pi guidance.
- `view-image/tool.ts`: schema and behavior track `codex-rs/core/src/tools/handlers/view_image_spec.rs` and `view_image.rs`, with Pi's optional text-model description fallback.
- `apply-patch/`: parser and patch language track `codex-rs/apply-patch` and the freeform tool contract, projected through Pi's function-tool argument. Pi additionally preflights the whole patch, participates in the shared file-mutation queue, and rejects stale concurrent writes instead of leaving upstream-style partial mutations after a later hunk fails.

Pi projects Codex namespace/code-mode tools as flat direct Pi tools because Pi does not expose Codex's nested code-mode runtime. It keeps native renderers and optional Glowup protocol adapters alongside the model-facing contracts.

The recorded `web_run` and `imagegen` description hashes and the `apply_patch` freeform specification remain unchanged through v0.150.1. Codex v0.148.0 introduced feature-gated apply-patch line-ending preservation, and v0.150.0 introduced feature-gated unified image budgeting that removes `view_image.detail`; both features remain disabled by default in v0.150.1, so Pi retains the stable default contracts. Pi already rejects invalid image data before returning `view_image` output.

Standalone `web_run` deliberately defaults to `live`. Codex v0.150.1 stores `cached` as its base preference but resolves eligible turns with `PermissionProfile::Disabled` (no outer sandbox) to `live`; Pi has no equivalent per-turn permission-profile resolver. Search result formatting removes internal citation markers while retaining explicit URLs, matching the upstream instruction that internal reference IDs stay inside tool calls and final answers cite Markdown links.
