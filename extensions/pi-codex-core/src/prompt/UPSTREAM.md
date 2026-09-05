# Upstream Codex Prompts

The model-specific prompt assets in this directory were copied from `codex-rs/models-manager/models.json` and verified against OpenAI Codex tag `rust-v0.153.4`, commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` (2026-09-04).

`codex-fallback-prompt.md` is the extension's Pi-adapted fallback for GPT model ids without a bundled model-specific prompt; it is not an upstream model prompt.

- `codex-gpt-6-astra.md`: `gpt-6-astra` `model_messages.instructions_template`, source-text SHA-256 `152dfaeeb552876190962be1c12c93d426840ff12691f648261554a7675a6698`
- `codex-gpt-5.6-sol.md`: shared `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` `model_messages.instructions_template`, source-text SHA-256 `cbefa6b0bede0e332d957fca70ccacf9f12f4c0ecdf81b819e5cbe1a3b16e265`
- `codex-gpt-5.6-terra-luna.md`: the same shared GPT-5.6 `model_messages.instructions_template`, source-text SHA-256 `cbefa6b0bede0e332d957fca70ccacf9f12f4c0ecdf81b819e5cbe1a3b16e265`
- `codex-gpt-5.5.md`: `gpt-5.5` `model_messages.instructions_template`, source-text SHA-256 `c13cc50bc068912608769224bf2c5ffcb5f534856fd631f3df0ef72a8a3108a4`
- `codex-gpt-5.5-personality-friendly.md`: `personality_friendly`, source-text SHA-256 `534873b3132a3e1db9782ffe8de56e64b2c74eb7e190aa2d0e7a0335fac09d50`
- `codex-gpt-5.5-personality-pragmatic.md`: `personality_pragmatic`, source-text SHA-256 `5ef72df6e1e414b4373b05c7db0340fa2e8254859b4551ae4441043da7ceac81`

Codex v0.147.0 consolidated model instructions under `model_messages`; the existing GPT-5 prompt text and recorded hashes remain unchanged through v0.153.4 and from v0.145.0. The runtime adapter in `src/prompt/system-prompt.ts` resolves supported personality templates, replaces Codex-only tool names and skill-loading mechanics, then appends Pi's active tool catalog, prompt guidelines, documentation paths, custom instructions, project context, skills, date, and working directory. GPT-6-Astra and GPT-5.6 advertise fixed prompts without personality-specific instructions, so the personality setting applies only to GPT-5.5.

Astra's runtime adaptation replaces `functions.exec`/Promise batching with capability-conditional Pi parallel-tool guidance. When `request_user_input_async` is active, the adapter uses its flat Pi name; otherwise it uses the synchronous `ask_user_question` contract if active, or ordinary conversation. It never infers asynchronous question support from the synchronous tool and preserves the rule that elapsed time is not an answer or approval. Only bundled instructions are transformed; appended Pi/custom instructions remain untouched.

`src/codex/models.ts` also tracks this catalogue's request metadata: Astra uses Responses Lite, low default reasoning, compaction hash `3000`, priority service tier, and original image detail. Its client-only `ultra` maps to the catalogue's `multi_agent_reasoning_effort` (`xhigh`); other models select a supported `max`, the last supported non-ultra effort, or `medium` when metadata is unavailable, matching `codex-rs/core/src/client.rs`. Fast-mode UI wording deliberately avoids a universal speed multiplier because the catalogue varies by model.

Pi chains `before_agent_start` handlers through one mutable system-prompt string but does not expose the pristine rendered prompt separately. The adapter therefore preserves a provable append-only suffix after Pi's working-directory boundary. If an earlier extension replaced or prepended the prompt so that the boundary cannot be recognized safely, Codex prompt mode remains authoritative and the extension emits one conflict warning per session instead of duplicating Pi's full base prompt.
