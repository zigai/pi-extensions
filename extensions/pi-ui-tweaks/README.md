# Pi UI Tweaks

<a href="https://www.npmjs.com/package/@zigai/pi-ui-tweaks"><img alt="npm version" src="https://img.shields.io/npm/v/@zigai/pi-ui-tweaks.svg?color=blue" style="display:inline-block;border:0" /></a> <a href="https://www.npmjs.com/package/@zigai/pi-ui-tweaks"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@zigai/pi-ui-tweaks.svg" style="display:inline-block;border:0" /></a> <a href="https://github.com/zigai/pi-tweaks/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@zigai/pi-ui-tweaks.svg" style="display:inline-block;border:0" /></a>

Small configurable UI tweaks for polishing Pi's interface.

Regular-mode frames include content and final hardware-cursor updates in one synchronized-output transaction. This does not change full-screen rendering. Set `mainScreenSynchronizedOutput: false` (or `enabled: false`) to retain native regular-mode output; session shutdown removes the patch.

## Compact startup

With `compactStartup: true`, keep Pi's native logo at a uniform 2× pixel scale (8 columns × 4 rows) and its original colors. On a wide-enough terminal, four text rows sit beside those four logo rows: white version text, then muted Context, Skills and Extensions. Context paths share one row separated by two spaces; the cwd's root instructions come first as `AGENTS.md`, with other paths retaining their normal home-abbreviated/full form. This changes display order only, not prompt ordering. If the paths do not fit, the layout falls back to the stacked, wrapped-path view instead of hiding filenames. Scaling uses the native foreground/background cells rather than a replacement drawing; startup/reload handoffs never scale it twice. Text wordmarks and unrecognized artwork retain their native fallback. The compact view has no shortcut legend; the existing expand-tools action still reveals native details. Long paths wrap rather than losing their filename.

The Skills row reports the loaded count and **estimated tokens in the startup skills catalog** (names, descriptions, locations and catalog framing). It reads Pi's effective system prompt, so skills omitted from that prompt do not contribute tokens. It does not count full skill bodies loaded later into conversation messages, and `~` denotes Pi's model-independent chars/4 estimate, not a provider tokenizer or billing count.

Counts are cached by the exact skill-section content, estimator revision and Pi version, in memory and across launches. The bounded 32-entry cache stores only hashes and counts at `$XDG_CACHE_HOME/pi-ui-tweaks/skill-tokens-v1.json` (normally `~/.cache/pi-ui-tweaks/skill-tokens-v1.json`). Cache hits do not estimate or rewrite the file. Changed descriptions/locations invalidate the relevant entry; unrelated context or skill-body-only changes do not. Cache corruption or unavailable storage falls back safely. No skill-file reads, tokenization, cache I/O or prompt construction occurs during header rendering.

## Install

```sh
pi install npm:@zigai/pi-ui-tweaks
```

<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-ui-tweaks.json`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Enable all UI tweaks. |
| `autocompleteAboveInput` | boolean | `true` | Render autocomplete above the input editor. |
| `bashExecPromptSpacing` | boolean | `true` | Add spacing around bash execution prompts. |
| `anchorInputToBottom` | boolean | `false` | Anchor the input editor to the terminal bottom. |
| `compactModelSelector` | boolean | `true` | Use compact model-selector rows. |
| `compactStartup` | boolean | `false` | Show a compact startup header; expand tools to reveal native help and loaded resources. |
| `dimInputBorder` | boolean | `true` | Dim the input editor's horizontal border lines. |
| `hideAutocompleteScrollInfo` | boolean | `true` | Hide autocomplete scroll-position text. |
| `hideModelChangeStatus` | boolean | `true` | Hide model-change status messages. |
| `hideModelProviderHint` | boolean | `true` | Hide provider hints in the model selector. |
| `hideSlashCommandSourceTags` | boolean | `true` | Hide source tags in slash-command completion. |
| `highlightSelectedModelProvider` | boolean | `true` | Highlight the selected model provider. |
| `offPeakRules` | [OffPeakRule](#settings-type-OffPeakRule)[] | `[]` | Opt in only after verifying the exact billing route, plan, model, endpoint, region and active offer. deepseek-reseller is OpenCode Go only; command is Command; glm is the Coding Plan; qwen is Alibaba Global PAYG; ali-qwen is eligible Alibaba personal Token Plan; ali-deepseek is eligible Alibaba PAYG or Token Plan; mimo is Token Plan. or requires verified OpenRouter routing and live endpoint metadata. |
| `deepseekHolidayCalendar` | [DeepSeekHolidayDate](#settings-type-DeepSeekHolidayDate)[] | `[]` | Authoritative Chinese public-holiday status by date for direct DeepSeek: true is a holiday, false is not. Unknown dates suppress predictions that depend on them. Keep dates current; reseller schedules do not use this calendar. |
| `pinnedModels` | string[] | `[]` | Pinned models in display order, each as provider/native-model-id (including virtual model IDs); aliases and display names do not change the key. |
| `inputPromptPrefix` | string | `"> "` | Prefix displayed before input text. |
| `mainScreenSynchronizedOutput` | boolean | `true` | Present regular-mode content and final cursor updates in one synchronized-output frame. |
| `neutralBorderColor` | boolean | `true` | Use a neutral border color when Pi is idle. |
| `pasteCollapseCharThreshold` | integer | `1000` | Character threshold that collapses pasted content. |
| `pasteCollapseEnabled` | boolean | `true` | Collapse large pasted content. |
| `pasteCollapseExpandKey` | string \| null | `null` | Explicit key used to expand collapsed pasted content. |
| `pasteCollapseLineThreshold` | integer | `10` | Line threshold that collapses pasted content. |
| `pasteCollapseUseToolExpandKey` | boolean | `true` | Reuse Pi's configured tool-expansion key for pasted content. |
| `preserveCompactionHistory` | boolean | `false` | Keep pre-compaction messages visible in transcript history. |
| `restoreContentAfterAutocompleteClose` | boolean | `true` | Restore editor content after closing autocomplete. |
| `refreshTmuxHyperlinks` | boolean | `true` | Refresh Markdown links when a tmux client attaches or detaches. |
| `selectedOptionPrefix` | string | `"→ "` | Prefix displayed before selected list options. |

```json
{
  "$schema": "./schemas/pi-ui-tweaks.schema.json",
  "enabled": true,
  "autocompleteAboveInput": true,
  "bashExecPromptSpacing": true,
  "anchorInputToBottom": false,
  "compactModelSelector": true,
  "compactStartup": false,
  "dimInputBorder": true,
  "hideAutocompleteScrollInfo": true,
  "hideModelChangeStatus": true,
  "hideModelProviderHint": true,
  "hideSlashCommandSourceTags": true,
  "highlightSelectedModelProvider": true,
  "offPeakRules": [],
  "deepseekHolidayCalendar": [],
  "pinnedModels": [],
  "inputPromptPrefix": "> ",
  "mainScreenSynchronizedOutput": true,
  "neutralBorderColor": true,
  "pasteCollapseCharThreshold": 1000,
  "pasteCollapseEnabled": true,
  "pasteCollapseExpandKey": null,
  "pasteCollapseLineThreshold": 10,
  "pasteCollapseUseToolExpandKey": true,
  "preserveCompactionHistory": false,
  "restoreContentAfterAutocompleteClose": true,
  "refreshTmuxHyperlinks": true,
  "selectedOptionPrefix": "→ "
}
```

### Structural types

<a id="settings-type-OffPeakRule"></a>

#### OffPeakRule

Additional fields are not allowed.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `provider` | string | Yes | Exact physical Pi provider ID. |
| `model` | string | Yes | Exact native model ID, not its display alias. |
| `openRouterBillingConfirmed` | boolean | No | For or only: you confirm OpenRouter billing (not BYOK) and no extension or proxy changes the configured routing. |
| `schedule` | `deepseek-direct` \| `deepseek-reseller` \| `command` \| `glm` \| `qwen` \| `ali-qwen` \| `ali-deepseek` \| `mimo` \| `or` | Yes | Selecting a schedule asserts the exact billing route, plan, region, endpoint, offer validity and no ineligible fallback. Only documented model IDs are accepted; or requires live OpenRouter metadata and verified Pi routing. |

<a id="settings-type-DeepSeekHolidayDate"></a>

#### DeepSeekHolidayDate

Additional fields are not allowed.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `date` | string | Yes | Beijing calendar date, YYYY-MM-DD. |
| `holiday` | boolean | Yes | True for a public holiday, false for a confirmed ordinary date. |
<!-- pi-extension-settings:end -->


## Model picker peak indicators

Indicators are disabled by default. Add an `offPeakRules` entry only after confirming the
exact Pi provider ID, native model ID, account plan, endpoint, region, and current offer
are eligible. Display aliases are not IDs. A mapping is your explicit eligibility assertion;
this extension cannot inspect your billing plan, and providers can change or end offers.
The following example is valid only when your OpenCode Go subscription allowance is active:

```json
{
  "offPeakRules": [
    { "provider": "opencode-go", "model": "deepseek-v4.1-flash", "schedule": "deepseek-reseller" }
  ],
  "deepseekHolidayCalendar": [
    { "date": "2026-01-05", "holiday": false }
  ]
}
```

Supported rules use these **exact native model IDs** (terms reviewed 2026-10-28):

| Schedule | Billing route and models | Off-peak UTC |
| --- | --- | --- |
| `deepseek-direct` | DeepSeek direct API: `deepseek-flash`, `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp` | Outside weekdays 01–04 and 06–10, plus verified Chinese public holidays |
| `deepseek-reseller` | OpenCode Go/Go Plus: `opencode-go/deepseek-v4.1-flash`, `opencode-go/deepseek-v4-pro` | Outside weekdays 01–04 and 06–10 |
| `command` | Command subscription or qualifying Provider API: `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4.1-flash`, `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-flash-vision-exp`, `deepseek/deepseek-v4.1-flash-fast` | Outside weekdays 01–04 and 06–10 |
| `glm` | Z.ai/BigModel Coding Plan: `glm-5.3`, `glm-5.3-flash` | Outside weekdays 06–10 |
| `qwen` | Alibaba PAYG: `qwen3.7-plus`, Global deployment in Hong Kong, Frankfurt, Virginia or Tokyo | Daily 14–24 |
| `ali-qwen` | Alibaba personal Token Plan in Beijing or Singapore: `qwen3.8-max`, `qwen3.8-flash` | Daily 14–24 |
| `ali-deepseek` | Eligible Alibaba hosted PAYG (eligible deployment/region) or personal/team Token Plan (Beijing or Singapore): `deepseek-v4-pro-0813`, `deepseek-v4-flash-0731`, `deepseek-v4.1-flash`, `deepseek-v4.1-flash-1017` | Daily 14–24 |
| `mimo` | Eligible Xiaomi Token Plan: `mimo-v2.6-pro`, `mimo-v2.6-flash` | Daily 16–24 |

The table does not imply that every tier, region or endpoint is eligible. For example,
Alibaba's Qwen token offer is personal-only; the Alibaba PAYG offer requires its eligible account, deployment and region, which the rule asserts rather than detects; MiMo PAYG and GLM ordinary API are not their
respective plan routes. Command contract and ZDR tariffs can differ. OpenCode Go allowance
exhaustion and PAYG overflow can change billing. Verify the actual route and promotion before
opting in, and remove the rule if it changes. Rules assert eligibility; they do not observe
account balances or actual subsequent request modifications. OpenRouter is the exception:
its `or` rule checks configured routing and current public endpoint prices as described below.
Qoder and Meoo app-only offers do not apply to Pi.
The indicator reports only state and countdown, not a percentage; GLM legacy and current
plans have different savings. Times are fixed UTC and the picker refreshes while open.

### OpenRouter

`or` supports only `openrouter/deepseek/deepseek-v4-pro-0813` and
`openrouter/deepseek/deepseek-v4-flash-0731`, and
`openrouter/deepseek/deepseek-v4.1-flash-1017`. Opt in with an exact rule such as:

```json
{ "provider": "openrouter", "model": "deepseek/deepseek-v4-pro-0813", "schedule": "or", "openRouterBillingConfirmed": true }
```

This confirmation is **your assertion**, not detected billing state: the request must use
OpenRouter billing, not BYOK, and no proxy, other extension or account setting may change the
configured routing. The extension reads the selected model's Pi `compat.openRouterRouting`;
it requires `only` with one supported exact upstream tag and `allow_fallbacks: false`, the
native OpenRouter HTTPS endpoint and the OpenAI-completions adapter. Nonempty model sampling
parameters are rejected because Pi applies those arbitrary fields after routing. Supported upstream tags
are `deepseek` (Pro-0813 or Flash-1017), `alibaba`, and `alibaba/us-east-1`. A broad tag matching more than
one live endpoint is rejected. Configure routing separately in Pi; this rule does not change it.

When such a model is selected, the picker fetches the public OpenRouter endpoint metadata
without credentials. It shows a countdown only if the exact endpoint is available and its
current UTC price overrides explicitly cover every minute, with input, output and cache-read
prices lower during the expected window. Unknown conditions, incomplete data, timeout,
ambiguous endpoints and network errors hide the indicator. Metadata is refreshed at least
once per minute while selected; prices, availability or account routing can change between
checks and the actual request. Do not configure OpenRouter under a custom provider alias as a
creator route. See [provider selection](https://openrouter.ai/docs/guides/routing/provider-selection)
and [price overrides](https://openrouter.ai/docs/guides/overview/models).

For `deepseek-direct`, maintain `deepseekHolidayCalendar` from an authoritative Chinese
public-holiday calendar: include each relevant Beijing date with `true` for a holiday and
`false` for a confirmed non-holiday. The indicator is hidden whenever the current state or
next transition depends on a missing date. Duplicate rules or duplicate calendar dates are
also treated as ambiguous and hidden. A configured calendar is not updated automatically;
review it regularly. No calendar is applied to reseller pricing without confirmation.

Review current provider terms before configuring a rule: [DeepSeek API pricing](https://api-docs.deepseek.com/quick_start/pricing/), [OpenCode Go usage](https://opencode.ai/v2/docs/console/go/), [Command Code pricing](https://commandcode.ai/docs/resources/pricing-limits), [Alibaba Model Studio pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing), and [MiMo Token Plan](https://mimo.mi.com/docs/zh-CN/price/token-plan), [GLM Coding Plan](https://docs.z.ai/devpack/overview), and [Alibaba China personal Token Plan](https://help.aliyun.com/zh/model-studio/token-plan-personal-overview), [international personal Token Plan](https://www.alibabacloud.com/help/en/model-studio/token-plan-personal-overview), and [international team Token Plan](https://www.alibabacloud.com/help/en/model-studio/token-plan-team-overview).

## License

MIT
