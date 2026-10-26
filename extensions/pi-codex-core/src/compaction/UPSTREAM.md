# Upstream Codex Compaction

The remote compaction v2 implementation is aligned with OpenAI Codex tag `rust-v0.153.4`, commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` (2026-09-04), primarily:

- `codex-rs/core/src/compact_remote_v2.rs`
- `codex-rs/core/src/compact_remote_v2_attempt.rs`
- `codex-rs/core/src/compact_remote_v2_images.rs`
- `codex-rs/core/src/compact_remote.rs`
- `codex-rs/core/src/responses_metadata.rs`
- `codex-rs/protocol/src/openai_models.rs`
- `codex-rs/core/src/client.rs`
- `codex-rs/codex-api/src/sse/responses.rs`

The Pi implementation preserves the Codex request shape, active system instructions and tools, compaction trigger, Responses Lite projection, reasoning context, transport metadata, stream validation/retries, 64k retained-user-message budget, compaction compatibility hash, and fresh world-state injection.

Retry advice and encrypted-checkpoint budgets follow tag `rust-v0.163.0`, commit `83086188ae0614bd882818ff1aa23f3194962012` (2026-10-15). `codex-rs/codex-api/src/responses_headers.rs` and `codex-rs/http-client/src/retry_after.rs` prioritize valid `Retry-After` headers over rate-limit message advice, preserving deadlines through response processing. Missing or unrepresentable delays use the existing 200/400ms backoff. The two-retry limit, cancellation, terminal classifications, and discard of failed partial outputs remain unchanged. Encrypted compaction items follow `codex-rs/core/src/context_manager/history.rs`: one token per twelve ciphertext bytes, rounded up, with framing counted separately.

Ordinary `reasoning` items use that file's separate reasoning estimate: floor three quarters of the UTF-8 ciphertext byte length, subtract 650 bytes with a zero floor, then divide by four bytes per token and round up. Their summary, plaintext content, and transport framing do not add replay tokens; reasoning without encrypted content contributes zero. These are model-visible estimates, not exact decrypted token counts. Both accounting paths preserve ciphertext in the outgoing request; the checkpoint heuristic must not be reused for ordinary reasoning.

Pi deliberately defaults automatic compaction to 80% rather than Codex v0.153.4's 90%, and defaults compaction reasoning to `medium` rather than the active model's default. The earlier threshold leaves headroom for Pi's provider projection and checkpoint replay; the fixed reasoning level keeps compaction cost and behavior predictable across model changes.

Pi stores an opaque native checkpoint in `CompactionEntry.details` and rewrites later provider requests because Pi's session format does not natively persist Codex `replacement_history`. Transcript conversion uses Pi 1.3's public projection and Responses converter, preserving system updates, encrypted reasoning, assistant phases, and tool metadata. Provider APIs resolve through the running host's published exports; callable checks retain their SDK types without requiring extension-local host peers. Requests still preflight at 80% of model context and fall back to Pi compaction rather than discard semantic input.

To preserve prompt-cache prefix parity, Pi Codex Core captures the provider-ready instructions, ordered tool definitions, prompt cache key, compatible reasoning controls, and Responses Lite developer prefix from the latest normal request in each session. Conversation input is never retained in this template. The template is scoped by session, model, wire layout, and active tool set, and is invalidated on session, model, or configuration changes. Compaction-only controls such as the trigger, encrypted-reasoning include, tool choice, and parallel-call policy remain aligned with the pinned Codex request shape. Pi's hook chain exposes the payload at this extension's position, so an extension loaded later can still rewrite fields after the captured snapshot.

Synthesized Responses Lite prefixes share deterministic UUIDv5 identities with ordinary provider requests. Both derive a namespace from the Pi session ID under the UUID OID namespace, then derive `at_` IDs from the serialized tool array and `msg_` IDs from instruction text, as in Codex's `core/src/client.rs`. IDs remain stable across retries and resumes without depending on the prompt-cache key. Captured provider prefixes are preserved when their content matches; changed tools or manual compaction guidance receive content-derived IDs. Pi serializes its own flat tool definitions rather than Codex's namespace schema.

Remote `response.completed` usage populates Pi's standard compaction `usage`, including cache writes, output/reasoning tokens, totals, and effective service-tier costs. Checkpoint `requestMeta` retains `inputTokens`, `cachedInputTokens`, and `providerTemplateUsed` for cache diagnostics without prompt contents.

Codex v0.150.1 charges retained images against the 64k retained-user-message budget by default. Pi matches its current estimates: high/auto images use a 7,373-byte estimate at four bytes per token, while original-detail data URLs use 32-pixel patches capped at 10,000. Images are atomic during boundary truncation, and the request preflight includes the same image cost instead of charging only the serialized data-URL placeholder.

Codex additionally groups its internal `image_resize_notice` developer messages with their source history items during compaction. Pi does not emit those Codex-internal notices, so there is no corresponding history item to retain or discard in this adapter. Codex rollout-budget usage is accounting metadata and does not alter the compact request or checkpoint replay contract.
