# Pi UI Tweaks

<a href="https://www.npmjs.com/package/@zigai/pi-ui-tweaks"><img alt="npm version" src="https://img.shields.io/npm/v/@zigai/pi-ui-tweaks.svg?color=blue" style="display:inline-block;border:0" /></a> <a href="https://www.npmjs.com/package/@zigai/pi-ui-tweaks"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@zigai/pi-ui-tweaks.svg" style="display:inline-block;border:0" /></a> <a href="https://github.com/zigai/pi-tweaks/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@zigai/pi-ui-tweaks.svg" style="display:inline-block;border:0" /></a>

Small configurable UI tweaks for polishing Pi's interface.

Regular-mode frames include content and final hardware-cursor updates in one synchronized-output transaction. This does not change full-screen rendering. Set `mainScreenSynchronizedOutput: false` (or `enabled: false`) to retain native regular-mode output; session shutdown removes the patch.

## Compact startup

With `compactStartup: true`, keep Pi's native logo and muted text, list each context file path, then show separate Skills and Extensions rows. The compact view has no shortcut legend; the existing expand-tools action still reveals native details. Long paths wrap rather than losing their filename.

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
<!-- pi-extension-settings:end -->

## License

MIT
