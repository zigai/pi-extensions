# Scoped Prompt History — shared Pi / OMP specification and implementation plan

Status: implementation contract, 2026-11-04. Requested by user: Claude Code fullscreen-style search of prior user prompts in Pi and OMP, selectable scopes, configurable default scope; shipped default MUST be project. Deliver as extensions in /home/fedora/Projects/pi-extensions and /home/fedora/Projects/omp-extensions. This does not require switching the host renderer to fullscreen.

## 1. Product scope

Provide a modal searchable prompt picker with results and a multiline preview, available in each interactive TUI. Search USER prompt text, not assistant/tool responses, system instructions, session titles, files, or semantic embeddings. Selecting a result copies its full original text to the current prompt editor; NEVER submits, executes shell input, resumes a conversation, rewinds, or switches sessions. Preserve existing arrow-key recall policy. Pi extends existing extensions/pi-prompt-history rather than adding a competing extension; OMP gets packages/omp-prompt-history. Use public host extension/UI/session APIs where available; guarded internal seams only when essential. Avoid replacing the user's editor or permanently patching built-in database schemas.

## 2. Scopes and identity (normative)

Enum: session | project | global; UI labels This session | This project | All projects.

- session: user messages in CURRENT host session, including its saved branches where accessible, plus unsaved current-session submitted prompts; no other session, even same project. Dedup at display only.
- project (DEFAULT): all sessions belonging to current project identity. Resolve each session's recorded cwd and current cwd: canonicalize realpath, then resolve Git worktree top-level root when available; otherwise exact canonical cwd. Subdirectories of one Git worktree belong together; separate worktrees remain separate. Never use string prefix matching (/app != /application). If canonicalization/Git lookup fails use a deterministic normalized absolute cwd fallback, not global. Cache cwd resolutions, use argv-based subprocess calls, never shell-interpolate recorded paths. Stored session cwd is authoritative (not current process cwd for old records).
- global: all discoverable sessions inside THIS HOST's configured session storage/active profile. Never mix Pi and OMP histories, other profiles/config roots, arbitrary filesystem paths, or other users. Honor configured agent/session dirs and host APIs; do not hardcode ~/.pi or ~/.omp.

A temporary picker scope change NEVER changes settings. Each new open re-resolves configured defaultScope; no sticky last-used scope. If scope has no matches stay scoped and show empty state, never silently widen.

## 3. Settings contract

Use each repository's existing extension-settings library and generation pipeline. Extension identifier prompt-history (follow existing host filename conventions). Fields: enabled boolean default true; defaultScope enum session/project/global default project. Additional searchShortcut setting only if host conventions require it; do not add needless tuning fields. Resolve normal settings precedence: defaults < global < trusted project. Invalid layers reported safely once, no silent rewrite and no values in diagnostics. Existing Pi arrow recall remains available if search disabled. Document actual generated file paths and an example {"defaultScope":"project"}. Users may choose session or global and the next opening must use that default. Persisted config changes take effect according to standard repository reload/session semantics; document them. No environment-variable-only preference and no core settings.json pollution.

## 4. Interaction

- Ctrl+R opens picker; also /prompt-history command as discoverable/fallback entrypoint. Inspect host conflict resolution. OMP's built-in Ctrl+R MUST be superseded while extension enabled through supported shortcut priority/input event interception or a carefully guarded reversible adapter. One key opens ONE picker; no duplicate built-in picker underneath. If host cannot safely intercept, disclose limitation rather than claiming success. Pi session-picker rename Ctrl+R must not be stolen globally.
- On open: empty query, configured default scope, newest entries, visible scope label and loading/partial status. Do not seed from draft. Save current draft; do not alter editor during navigation.
- Ctrl+S cycles session -> project -> global -> session; preserve query, reset selected result appropriately, cancel/invalidate prior scope search. Footer shows scope cycle shortcut; repeated Ctrl+R may be ignored rather than cycle.
- Up/Down navigate results, PageUp/PageDown page, no wrap required. Selection stays stable by result identity while incremental arrivals reorder, unless query/scope changed.
- Enter or Tab accepts full original prompt text into editor and closes; no submit. Escape or Ctrl+C closes and preserves original draft exactly. Repeated close/accept is idempotent; Enter with no selection does nothing.
- Query text editing uses host Input component where possible. Matching: Unicode lowercasing + whitespace-separated query tokens, ALL tokens literal substrings of full user text, any order; normalize whitespace in matching copy only so multiline pasted queries work. Empty/whitespace query shows recent. Punctuation is literal, not regex or FTS syntax. No fuzzy/regex/semantic claims in v1.
- Dedup AFTER applying scope: exact original prompt text duplicates collapse to newest matching occurrence, with deterministic timestamp/session/entry tie-break. Preserve full original text for insertion. Do not globally discard occurrence provenance.
- Row: concise whitespace-collapsed snippet, timestamp/age, optional project indicator; preview: multiline full prompt in bounded scrollable pane, with clear truncation/scroll hint if needed. Highlight matching substrings where feasible with safe terminal-width rendering. Long Unicode/ANSI-like content must not inject terminal escapes or exceed width.
- Small terminals degrade to stacked list/preview; do not crash or cover controls. Loading, empty scope, no matches, partial unreadable sessions, and total storage failure must be distinct. Never expose raw prompt text in logs/errors.

## 5. Data and correctness

Use saved session records as occurrence-preserving source, plus live session context/events for freshest unsaved submitted prompts. Filter user role, extract text blocks in original order; omit image/binary/tool/custom/assistant content. Do not ingest user-looking text from assistant/tool results. Avoid persisting synthetic expanded system/skill context where host exposes original user input; document any host limitation.

OMP's native history.db has globally unique prompt rows and latest-only cwd/session metadata: it CANNOT be the sole authoritative source for session/project scope. Do not migrate/alter it; authoritative scoped occurrence retrieval must use session data. Same prompt submitted in two projects must be retrievable in BOTH project scopes. Pi active branch editor recall remains independent from all-branch search.

Preserve provenance internally: host session ID, entry ID or deterministic occurrence ID, timestamp, cwd/project identity, prompt text. Do not read personal history during development/review: use synthetic temp fixtures or isolated configs. Do not create a second persistent plaintext prompt store in v1. In-memory cache allowed; clear on shutdown/reload and invalidate on file mtime/size/session updates; catch same-size/mtime edge cases as supported or document. Own cache lifecycle, no module-global sessions surviving disposal.

Discovery/parsing must be async, cancellable or generation-guarded, bounded concurrency, progressive. Do not synchronously scan all transcripts on keypress or silently cap coverage at latest 100 records. Can virtualize/paginate rendered results, but all discoverable matching prompts must remain reachable. Scopes/queries can change mid-load: stale completions never replace current result state. Corrupt/unreadable/deleted sessions are skipped with aggregate non-sensitive diagnostic and partial indicator. No network requests, no model calls, no changes to host retention/security or live configuration. Cancellation must finish promptly; filesystem failures must not crash host. If session storage is unavailable, show accurately limited live-only coverage rather than imply complete results.

## 6. Lifecycle and coexistence

Noninteractive/headless invocation registers harmlessly; only create UI when ctx.hasUI. Prevent overlapping opens. Settings loading uses repository lifecycle and trusted project handling. Own input listeners, timers, caches, overlays, pending async generations; dispose on session change/reset/reload/shutdown. Editor draft unchanged on cancel even with multiline/paste markers; original attachments remain owned by host. Acceptance replaces TEXT only and must not attach stale image/paste metadata to newly inserted prompt. Document attachment-text-only limitation. Do not reload or reconfigure user's live Pi/OMP automatically. Guard private API version mismatches with one clear warning and command fallback, never startup crash.

## 7. Deliverables and implementation sequence

1. Copy this spec into each extension's docs/scoped-history-spec.md; adapt paths to repository conventions and record intentional deviations/actual API constraints rather than hiding them.
2. Inspect AGENTS.md, existing history extension/settings/UI/host compatibility and tests. Record supported host version range and integration strategy.
3. Implement pure scope/project identity, extraction, matching, occurrence dedup, deterministic ordering with shared behavior fixtures (same cases independently in both repos; no runtime cross-checkout imports).
4. Implement async host session source + live merge, progressive lifecycle-safe search/cache controller.
5. Implement picker list/preview, keyboard routing, settings/defaultScope, slash fallback, reversible host integration.
6. Generate schema/settings artifacts; update READMEs, collection/manifests/lockfiles only as required. Follow each monorepo's packaging/version policy; no publish/release or commit unless requested.
7. Run unit/integration/render tests, typecheck/lint/format/generation/packaging and root check. Use isolated real TUI smoke test where possible; clearly distinguish real evidence from mocks/static review. Report exact commands and pre-existing failures.

## 8. Acceptance / verification matrix

A. Fresh config opens PROJECT in both hosts. Setting each of session/project/global changes next open; invalid config handled, trusted project precedence verified; cycling does not persist.
B. Fixtures: projects A and B, two sessions A1/A2, B1, Git subdir in A, separate Git worktree A-other, non-Git paths, symlink alias. Session A1 excludes A2/B1; project A includes A1/A2/subdir and excludes B/A-other; global includes all. Same prompt in A and B appears scoped in both, latest occurrence chosen within scope.
C. Empty/multitoken/case/multiline/punctuation/Unicode matching, deterministic ties, no hidden 100-entry ceiling, image-only/assistant/tool exclusion, original text preserved after insertion.
D. Enter and Tab insert once without model submission; Escape/Ctrl+C preserve draft and attachments; zero results cannot accept; opening twice safe; Ctrl+S preserves query; real Ctrl+R does not trigger two overlays or hijack Pi rename context.
E. Delayed source out of order + rapid query/scope changes/session switch/dispose: no stale results; bounded concurrency, loading/partial/no-results states, corrupt/deleted/unreadable files handled; cancellation cleans listeners/timers.
F. Large result set (e.g. >=1000 synthetic prompts incl older unique match), long multiline/Unicode/narrow terminal previews, no ANSI injection, no synchronous full-history scan at open. Performance timings reported if measured, not fabricated.
G. Existing Pi arrow recall tests and OMP existing composer/extension tests unaffected. Settings generation clean, package exports/collection load correct, no tests touching real prompt history or user settings.

## 9. Out of scope

No assistant/tool transcript search, semantic embeddings, external search, cross-host history import, fuzzy algorithms, repository-wide grouping across worktrees, disk index/store, history deletion/retention UI, permanent native history schema change, automatic installation into user config, or changes to Codex/Claude Code.

## 10. Work ownership and baseline

Pi worker: /home/fedora/Projects/pi-extensions only; existing extensions/pi-prompt-history and required generated/collection integration files. Preserve pre-existing untracked bun.lock.
OMP worker: /home/fedora/Projects/omp-extensions only; new packages/omp-prompt-history plus src/index.ts, spec/docs, and minimal package/build wiring. PRE-EXISTING DIRTY FILES: root README.md/docs/omp-compatibility.md/package.json; packages/omp-glowup src/core/formatting.ts src/hosts/formatting.ts src/hosts/omp.ts test/formatting.test.ts; packages/omp-ui-tweaks README.md/config.schema.json/src/index.ts/src/settings.ts/src/ui-rendering.ts/test/settings.test.ts/test/ui-tweaks.test.ts; untracked packages/omp-ui-tweaks/src/composer-layout.ts/test/host-rendering.ts. Do not revert, reformat, stage, or commit these unrelated edits. If root integration needs touching existing dirty README/package.json, make narrowly additive edits and explain them. Do not modify ui-tweaks/glowup. No worker delegation; lead owns cross-repo evaluation.
