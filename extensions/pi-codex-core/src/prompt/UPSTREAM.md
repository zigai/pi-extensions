# Upstream Codex Prompts

The model-specific prompt assets in this directory were copied from `codex-rs/models-manager/models.json` at OpenAI Codex commit `22781d40019779abc158723f2387cc6bce22a7ce` (2026-07-09).

`codex-fallback-prompt.md` is the extension's Pi-adapted fallback for GPT model ids without a bundled model-specific prompt; it is not an upstream model prompt.

- `codex-gpt-5.6-sol.md`: `gpt-5.6-sol` `base_instructions`, source-text SHA-256 `e9778714d505f3dd04d44db4394024c5fab5bf6554fc9faa3cdf9cf776b63bb9`
- `codex-gpt-5.6-terra-luna.md`: shared `gpt-5.6-terra` and `gpt-5.6-luna` `base_instructions`, source-text SHA-256 `78a2fc84e1bffa421d865c1a2ade4185d3d33ef38e6a15157f0ff1a89b7d52ec`
- `codex-gpt-5.5.md`: `gpt-5.5` `model_messages.instructions_template`, source-text SHA-256 `c13cc50bc068912608769224bf2c5ffcb5f534856fd631f3df0ef72a8a3108a4`
- `codex-gpt-5.5-personality-friendly.md`: `personality_friendly`, source-text SHA-256 `534873b3132a3e1db9782ffe8de56e64b2c74eb7e190aa2d0e7a0335fac09d50`
- `codex-gpt-5.5-personality-pragmatic.md`: `personality_pragmatic`, source-text SHA-256 `5ef72df6e1e414b4373b05c7db0340fa2e8254859b4551ae4441043da7ceac81`

The runtime adapter in `src/prompt/system-prompt.ts` resolves supported personality templates, replaces Codex-only tool names and skill-loading mechanics, then appends Pi's active tool catalog, prompt guidelines, documentation paths, custom instructions, project context, skills, date, and working directory. GPT-5.6 currently advertises fixed prompts without personality-specific instructions, so the personality setting applies only to GPT-5.5.
