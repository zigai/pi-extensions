# Upstream Codex Compaction

The remote compaction v2 implementation is aligned with OpenAI Codex tag `rust-v0.145.0`, commit `25af12f7e61572b0bc18ddb1008be543b91519b0` (2026-07-21), primarily:

- `codex-rs/core/src/compact_remote_v2.rs`
- `codex-rs/core/src/compact_remote_v2_attempt.rs`
- `codex-rs/core/src/compact_remote.rs`
- `codex-rs/core/src/responses_metadata.rs`
- `codex-rs/protocol/src/openai_models.rs`

The Pi implementation preserves the Codex request shape, active system instructions and tools, compaction trigger, Responses Lite projection, reasoning context, transport metadata, stream validation/retries, 64k retained-user-message budget, compaction compatibility hash, and fresh world-state injection.

Pi deliberately defaults automatic compaction to 80% rather than Codex v0.145.0's 90%, and defaults compaction reasoning to `medium` rather than the active model's default. The earlier threshold leaves headroom for Pi's provider projection and checkpoint replay; the fixed reasoning level keeps compaction cost and behavior predictable across model changes.

Pi stores an opaque native checkpoint in `CompactionEntry.details` and rewrites later provider requests because Pi's session format does not natively persist Codex `replacement_history`. It also preflights remote requests at 80% of the model context and falls back to Pi compaction instead of discarding semantic input when a remote request still cannot fit.
