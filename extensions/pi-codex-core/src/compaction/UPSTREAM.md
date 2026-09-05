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

Streaming `response.failed` events retain code-based retry classification. `rate_limit_exceeded` preserves the server's retry delay in its message; other transient failures use the existing 200/400ms backoff. The existing two-retry limit and cancellation-aware runtime scheduler remain in force. Policy, quota, context-window, invalid-input/request failures, and incomplete responses remain nonretryable; Pi additionally recognizes explicit invalid-request types and codes. Missing or unrepresentable timer delays use the bounded retry backoff. Partial outputs from a failed attempt are discarded before retrying the same encoded request.

Pi deliberately defaults automatic compaction to 80% rather than Codex v0.153.4's 90%, and defaults compaction reasoning to `medium` rather than the active model's default. The earlier threshold leaves headroom for Pi's provider projection and checkpoint replay; the fixed reasoning level keeps compaction cost and behavior predictable across model changes.

Pi stores an opaque native checkpoint in `CompactionEntry.details` and rewrites later provider requests because Pi's session format does not natively persist Codex `replacement_history`. It also preflights remote requests at 80% of the model context and falls back to Pi compaction instead of discarding semantic input when a remote request still cannot fit.

To preserve prompt-cache prefix parity, Pi Codex Core captures the provider-ready instructions, ordered tool definitions, prompt cache key, compatible reasoning controls, and Responses Lite developer prefix from the latest normal request in each session. Conversation input is never retained in this template. The template is scoped by session, model, wire layout, and active tool set, and is invalidated on session, model, or configuration changes. Compaction-only controls such as the trigger, encrypted-reasoning include, tool choice, and parallel-call policy remain aligned with the pinned Codex request shape. Pi's hook chain exposes the payload at this extension's position, so an extension loaded later can still rewrite fields after the captured snapshot.

Synthesized Responses Lite prefixes share deterministic UUIDv5 identities with ordinary provider requests. Both derive a namespace from the Pi session ID under the UUID OID namespace, then derive `at_` IDs from the serialized tool array and `msg_` IDs from instruction text, as in Codex's `core/src/client.rs`. IDs remain stable across retries and resumes without depending on the prompt-cache key. Captured provider prefixes are preserved when their content matches; changed tools or manual compaction guidance receive content-derived IDs. Pi serializes its own flat tool definitions rather than Codex's namespace schema.

Remote `response.completed` usage is stored in the checkpoint's `requestMeta` as `inputTokens` and `cachedInputTokens`, together with `providerTemplateUsed`, so cache behavior can be measured from session data without logging prompt contents.

Codex v0.150.1 charges retained images against the 64k retained-user-message budget by default. Pi matches its current estimates: high/auto images use a 7,373-byte estimate at four bytes per token, while original-detail data URLs use 32-pixel patches capped at 10,000. Images are atomic during boundary truncation, and the request preflight includes the same image cost instead of charging only the serialized data-URL placeholder.

Codex additionally groups its internal `image_resize_notice` developer messages with their source history items during compaction. Pi does not emit those Codex-internal notices, so there is no corresponding history item to retain or discard in this adapter. Codex rollout-budget usage is accounting metadata and does not alter the compact request or checkpoint replay contract.
