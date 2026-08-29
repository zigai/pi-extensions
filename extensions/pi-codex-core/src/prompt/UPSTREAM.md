# Upstream Codex Prompts

The model-specific prompt assets in this directory were copied from `codex-rs/models-manager/models.json` and verified against OpenAI Codex tag `rust-v0.150.1`, commit `90854393966b21e9ebfd21b122334eb09a20c93d` (2026-08-27).

`codex-fallback-prompt.md` is the extension's Pi-adapted fallback for GPT model ids without a bundled model-specific prompt; it is not an upstream model prompt.

- `codex-gpt-5.6-sol.md`: shared `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` `model_messages.instructions_template`, source-text SHA-256 `cbefa6b0bede0e332d957fca70ccacf9f12f4c0ecdf81b819e5cbe1a3b16e265`
- `codex-gpt-5.6-terra-luna.md`: the same shared GPT-5.6 `model_messages.instructions_template`, source-text SHA-256 `cbefa6b0bede0e332d957fca70ccacf9f12f4c0ecdf81b819e5cbe1a3b16e265`
- `codex-gpt-5.5.md`: `gpt-5.5` `model_messages.instructions_template`, source-text SHA-256 `c13cc50bc068912608769224bf2c5ffcb5f534856fd631f3df0ef72a8a3108a4`
- `codex-gpt-5.5-personality-friendly.md`: `personality_friendly`, source-text SHA-256 `534873b3132a3e1db9782ffe8de56e64b2c74eb7e190aa2d0e7a0335fac09d50`
- `codex-gpt-5.5-personality-pragmatic.md`: `personality_pragmatic`, source-text SHA-256 `5ef72df6e1e414b4373b05c7db0340fa2e8254859b4551ae4441043da7ceac81`

Codex v0.147.0 consolidated model instructions under `model_messages`; the prompt text and recorded hashes remain unchanged through v0.150.1 and from v0.145.0. The runtime adapter in `src/prompt/system-prompt.ts` resolves supported personality templates, replaces Codex-only tool names and skill-loading mechanics, then appends Pi's active tool catalog, prompt guidelines, documentation paths, custom instructions, project context, skills, date, and working directory. GPT-5.6 currently advertises fixed prompts without personality-specific instructions, so the personality setting applies only to GPT-5.5.

Pi chains `before_agent_start` handlers through one mutable system-prompt string but does not expose the pristine rendered prompt separately. The adapter therefore preserves a provable append-only suffix after Pi's working-directory boundary. If an earlier extension replaced or prepended the prompt so that the boundary cannot be recognized safely, Codex prompt mode remains authoritative and the extension emits one conflict warning per session instead of duplicating Pi's full base prompt.
