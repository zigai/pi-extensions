# Upstream Codex Compaction

The remote compaction v2 implementation is aligned with OpenAI Codex tag `rust-v0.147.0`, commit `be6e8eac029b183056b7e4402879f15d2c85f61b` (2026-08-06), primarily:

- `codex-rs/core/src/compact_remote_v2.rs`
- `codex-rs/core/src/compact_remote_v2_attempt.rs`
- `codex-rs/core/src/compact_remote.rs`
- `codex-rs/core/src/responses_metadata.rs`
- `codex-rs/protocol/src/openai_models.rs`

The Pi implementation preserves the Codex request shape, active system instructions and tools, compaction trigger, Responses Lite projection, reasoning context, transport metadata, stream validation/retries, 64k retained-user-message budget, compaction compatibility hash, and fresh world-state injection.

Pi deliberately defaults automatic compaction to 80% rather than Codex v0.147.0's 90%, and defaults compaction reasoning to `medium` rather than the active model's default. The earlier threshold leaves headroom for Pi's provider projection and checkpoint replay; the fixed reasoning level keeps compaction cost and behavior predictable across model changes.

Pi stores an opaque native checkpoint in `CompactionEntry.details` and rewrites later provider requests because Pi's session format does not natively persist Codex `replacement_history`. It also preflights remote requests at 80% of the model context and falls back to Pi compaction instead of discarding semantic input when a remote request still cannot fit.

To preserve prompt-cache prefix parity, Pi Codex Core captures the provider-ready instructions, ordered tool definitions, prompt cache key, compatible reasoning controls, and Responses Lite developer prefix from the latest normal request in each session. Conversation input is never retained in this template. The template is scoped by session, model, wire layout, and active tool set, and is invalidated on session, model, or configuration changes. Compaction-only controls such as the trigger, encrypted-reasoning include, tool choice, and parallel-call policy remain aligned with the pinned Codex request shape. Pi's hook chain exposes the payload at this extension's position, so an extension loaded later can still rewrite fields after the captured snapshot.

Remote `response.completed` usage is stored in the checkpoint's `requestMeta` as `inputTokens` and `cachedInputTokens`, together with `providerTemplateUsed`, so cache behavior can be measured from session data without logging prompt contents.

Codex v0.147.0 additionally groups its internal `image_resize_notice` developer messages with their source history items during compaction. Pi does not emit those Codex-internal notices, so there is no corresponding history item to retain or discard in this adapter. The v0.147.0 rollout-budget usage field is Codex accounting metadata and does not alter the compact request or checkpoint replay contract.
