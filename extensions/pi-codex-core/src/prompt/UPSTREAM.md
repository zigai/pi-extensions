# Upstream Codex Prompts

The model-specific prompt assets in this directory were copied from `codex-rs/models-manager/models.json` and verified against OpenAI Codex tag `rust-v0.164.0`, commit `6aaac694803004a63c6f393d153c96d22521a6b9` (2026-10-23).

`codex-fallback-prompt.md` is the extension's Pi-adapted fallback for GPT model ids without a bundled model-specific prompt; it is not an upstream model prompt.

- `codex-gpt-6.1-sol.md`: `gpt-6.1-sol` `model_messages.instructions_template`, source-text SHA-256 `e1bdd4f8f0df4b20f4a0ffc8a861ce819df45325d8cecdfb92e80379cf8d142e`
- `codex-gpt-6-sol.md`: `gpt-6-sol` `model_messages.instructions_template`, source-text SHA-256 `b1dd8718c037906c53a305c5cbccb4a4be35ccbb7837461ec349bfc495412f0d`
- `codex-gpt-6-luna.md`: `gpt-6-luna` `model_messages.instructions_template`, source-text SHA-256 `b707476816bfe5e571a1bd2179f130fff2b132da5ab8e61063acdb7fd24daf12`
- `codex-gpt-6-astra.md`: `gpt-6-astra` `model_messages.instructions_template`, source-text SHA-256 `35bd51b5f577cb7b24cd5f4629e49e37cb724ab57754ce6f8f202001635bab8a`
- `codex-gpt-5.6-sol.md`: shared `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` `model_messages.instructions_template`, source-text SHA-256 `a91357a1cd2727a0be06d461248d6e3a7274746e38108f548a3adf2cc2430415`
- `codex-gpt-5.6-terra-luna.md`: the same shared GPT-5.6 `model_messages.instructions_template`, source-text SHA-256 `a91357a1cd2727a0be06d461248d6e3a7274746e38108f548a3adf2cc2430415`
- `codex-gpt-5.5.md`: `gpt-5.5` `model_messages.instructions_template`, source-text SHA-256 `2351631dfc5644dc5a45eaaca4139475bd02810ee6cb792d058b551559b3242e`
- `codex-gpt-5.5-personality-friendly.md`: `personality_friendly`, source-text SHA-256 `534873b3132a3e1db9782ffe8de56e64b2c74eb7e190aa2d0e7a0335fac09d50`
- `codex-gpt-5.5-personality-pragmatic.md`: `personality_pragmatic`, source-text SHA-256 `5ef72df6e1e414b4373b05c7db0340fa2e8254859b4551ae4441043da7ceac81`

Codex v0.164.0 embeds GPT-5.5's friendly personality in its template. The runtime adapter replaces it with the selected personality, retaining Pi's existing options; the separate personality assets are from tag `rust-v0.153.4`. It replaces Codex-only tool names and skill-loading mechanics, then appends Pi's active tool catalog, prompt guidelines, documentation paths, custom instructions, project context, skills, date, and working directory. GPT-6-Astra and GPT-5.6 have fixed personalities, so the personality setting applies only to GPT-5.5.

Astra's runtime adaptation replaces `functions.exec`/Promise batching with capability-conditional Pi parallel-tool guidance. When `request_user_input_async` is active, the adapter uses its flat Pi name; otherwise it uses the synchronous `ask_user_question` contract if active, or ordinary conversation. It never infers asynchronous question support from the synchronous tool and preserves the rule that elapsed time is not an answer or approval. Only bundled instructions are transformed; appended Pi/custom instructions remain untouched.

`src/codex/models.ts` also tracks the pinned catalogues' request metadata: Astra and GPT-6.1 Sol use Responses Lite, low default reasoning, compaction hash `3000`, priority service tier, and original image detail. Sol and Luna use Responses Lite, medium default reasoning, compaction hash `3000`, priority service tier, and original image detail; Sol supports `ultra`, while Luna supports efforts through `max`. Astra's and GPT-6.1 Sol's client-only `ultra` map to the catalogue's `multi_agent_reasoning_effort` (`xhigh`); other models select a supported `max`, the last supported non-ultra effort, or `medium` when metadata is unavailable, matching `codex-rs/core/src/client.rs`. Fast-mode UI wording deliberately avoids a universal speed multiplier because the catalogue varies by model.

Pi 0.86.1 chains `before_agent_start` handlers through mutable structured prompt options. Returned prompt strings become `forceSystemPrompt`; structured edits alone never constitute a replacement conflict. The adapter preserves active tools' `toolGuidelines` alongside `promptGuidelines`, and honors nonempty custom `sections`, including overrides of standard sections. Pi's native renderer is not a public package export, so production code retains its Pi-specific context rendering; regression tests exercise the installed Pi renderer directly.

For an earlier forced prompt, the adapter recognizes the original preamble and XML-wrapped working-directory/custom-section boundaries, preserving the suffix after the final boundary once. This is boundary recognition, not a byte-for-byte comparison of the full original prompt. An unrecognizable replacement or prepend leaves Codex prompt mode authoritative and emits one conflict warning per session. The old plain-text working-directory marker is no longer used for conflict detection.
