# pi-input-corrections

Conservative, ordered corrections for interactive Pi prose using one personal policy shared with OMP. Corrections are disabled until `policyFile` is configured; no personal rules ship in this package.

```sh
pi install npm:@zigai/pi-input-corrections
```

The extension only handles Pi's `interactive` input source (including queued steering/follow-up input). RPC and extension-generated input are untouched. Attachments are passed through unchanged. Settings load once on first interactive input per session, including disabled/invalid results; start a new session to reload.

## Correction policy and limitations

- The built-in runs first, then enabled custom rules in array order, once each. No recursive retry. Literal and word rules replace all eligible occurrences; regex rules honor their flags. Word rules require one literal word (Unicode letters, marks, numbers or underscore), with Unicode-aware boundaries to avoid identifiers and substrings. Replacement strings are literal, including `$&` and `$1`; no callbacks or executable configuration.
- Slash commands, shell escapes, fenced/indented code and common code syntax skip the whole prompt. Command-line flags, URLs, path-like tokens (absolute/relative/Windows paths and filenames), backtick snippets, double-quoted literals and paired single-quoted literals are protected spans. Matches crossing these spans are skipped. Contractions and escaped apostrophes are preserved.
- The built-in requires a multiword prompt containing a letter. It preserves paired/unclosed quotes and a trailing escaped apostrophe. Trailing whitespace is preserved, with the last non-whitespace apostrophe corrected. This intentionally leaves single-word cases (including possessives such as `dogs'`) unchanged rather than guessing.
- These are lexical heuristics, not a language parser. Unmarked code, unusual URL forms, natural-language possessives, and nested/mixed quote styles can be ambiguous. Disable the built-in or extension when exact input is important. Prefer explicit word or literal rules.
- Prompts over 65,536 UTF-16 code units are untouched. Built-in and literal rules operate up to that bound; regex rules are skipped when current input exceeds 2,048 units. Later rules stop if intermediate output exceeds 65,536 units. Output over 131,072 units rolls back the entire correction; input is never truncated.
- Regex uses a deliberately restricted JavaScript subset: flags `gimsu` without duplicates; no groups, alternatives, backreferences, Unicode/property/hex escapes or bounded repetitions; at most one `*`, `+`, or `?` quantifier outside character classes. Anchors, character classes and ordinary escapes are supported. Patterns must consume at least one character. Invalid or unsafe rules are skipped with a diagnostic once per session; configured text and names are not included in diagnostics.
- Regex execution is synchronous. The subset and fixed pattern/input bounds reduce backtracking risk but are not a general regex sandbox. Configuration is trusted policy; use simple patterns and do not automatically import untrusted rules.

For a deliberate word correction, configure `{ "name": "Project word", "kind": "word", "find": "shorthand", "replacement": "terminology" }`. It is case-sensitive and preserves identifiers, filenames and flags. No word corrections ship enabled.

For a phrase-specific regex, configure a rule such as `{ "name": "Project phrase", "kind": "regex", "find": "\\bproject shorthand\\b", "replacement": "project terminology", "flags": "gi" }`. Set `trailingQuestionMark: false` in the policy to use custom rules only, or `enabled: false` in Pi's settings to disable all corrections. Project settings never contribute, even in trusted projects.

## Matching cost

Matching runs on submitted messages, not editor keystrokes. Absent literal/word patterns skip replacement work. Protected spans are parsed only for a viable match and reused while text stays unchanged; any actual replacement invalidates that cache before later rules. Ordered replacements, newly introduced code/quotes, and whole-input overflow rollback retain the same behavior. Settings and compiled rules are loaded once per session, not per message.

## Reusable engine

The explicit `@zigai/pi-input-corrections/engine` export provides `createCorrectionEngine(settings)`, returning `{ correct(text), diagnostics }`. Pass fully resolved settings (`enabled`, `trailingQuestionMark`, `rules`; each rule includes `name`, `find`, `replacement`, and optional `enabled`/`kind`/`flags` defaulting to `true`/`literal`/`g`). It performs no Pi registration or filesystem I/O. The extension root is the Pi entrypoint.

The `@zigai/pi-input-corrections/policy` export provides synchronous `loadCorrectionPolicy(policyFile, configFile): LoadedCorrectionPolicy`, returning `{ engine, diagnostics }`. Each diagnostic has `message` and `severity` (`warning` or `error`). The loader performs strict structural validation using the exported TypeBox `policySchema`; `policy.schema.json` is its canonical editor schema. It registers no harness handlers. Harness adapters own session caching; the shared loader has no watcher or process-wide cache.

## Personal policy and migration

Pi reads only `~/.pi/agent/extension-settings/pi-input-corrections.json` (or the agent directory selected by Pi), not `.pi/extension-settings` in a project. Its only settings are `enabled` and `policyFile`, plus editor `$schema` metadata.

Existing inline `rules` and `trailingQuestionMark` settings must be migrated explicitly:

1. Move those two fields, unchanged, into your personal `~/.config/input-corrections/policy.json` and add `"version": 1` (include `"rules": []` if you had no rules). Remove the inline fields from both Pi's global settings and any old project settings; the old inline format is rejected, not merged or silently supported.
2. Replace Pi's settings with `{ "enabled": true, "policyFile": "~/.config/input-corrections/policy.json" }`. Point OMP at the same personal policy file.
3. Start a new session after editing settings or the policy. The first interactive submission loads and compiles once; disabled and invalid results are cached too. Session start/shutdown clears this cache. No filesystem watching or per-message policy reads occur.

A policy has this shape (these examples are generic, not a bundled correction list):

```json
{
  "$schema": "https://raw.githubusercontent.com/zigai/pi-tweaks/master/extensions/pi-input-corrections/policy.schema.json",
  "version": 1,
  "trailingQuestionMark": true,
  "rules": [
    { "name": "Expand shorthand", "kind": "word", "find": "shorthand", "replacement": "terminology" }
  ]
}
```

The optional `$schema` is editor metadata. `version` must be `1` and `rules` must be an array (use `[]` for built-in only). Omitted `trailingQuestionMark` defaults to `true`; unknown fields, incorrect types, more than 512 rules, and rule field length violations reject the whole policy. Rule names are required (1–80 characters), `find` is 1–128 characters, and replacement text is at most 1,024 characters. Optional `enabled`, `kind`, and `flags` retain the engine defaults described above.

An empty `policyFile` intentionally disables corrections without a diagnostic or private fallback. `~/` expands using the operating system home directory, in either path argument. Absolute policy paths are used directly; relative policy paths resolve beside the harness settings file, never against the current project or working directory. The public loader requires an absolute (or `~/`-based) `configFile` to keep that base unambiguous.

Unreadable/missing files, malformed JSON, and invalid structure disable corrections for the session and return actionable, value-safe errors; the prompt still proceeds unchanged. Semantically invalid/unsafe rules are skipped with position-only warnings while valid rules continue. Neither policy content, rule names nor raw parser errors appear in diagnostics. Pi reports diagnostics at most once per session, through the UI when available or standard error otherwise, and never overwrites an invalid policy. Invalid harness configuration likewise disables corrections. Existing engine ordering, protected spans, bounded matching, and overflow rollback apply identically in both harnesses.


<!-- pi-extension-settings:start -->
## Configuration

Global settings are stored in `~/.pi/agent/extension-settings/pi-input-corrections.json`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Enable interactive input corrections. |
| `policyFile` | string | `""` | Personal policy JSON path. Empty disables corrections; ~/ expands to home, relative paths resolve beside this settings file. |

### Defaults

```json
{
  "$schema": "./schemas/pi-input-corrections.schema.json",
  "enabled": true,
  "policyFile": ""
}
```

### Advanced example

```json
{
  "$schema": "./schemas/pi-input-corrections.schema.json",
  "enabled": true,
  "policyFile": "~/.config/input-corrections/policy.json"
}
```
<!-- pi-extension-settings:end -->
