# Scoped history: Pi integration and verification

## Integration and limits

The shared contract is copied verbatim to [scoped-history-spec.md](scoped-history-spec.md).
Only the Pi repository is implemented here. No OMP code or histories are accessed.
The package retains its Pi `^1.3.0` peer range; verification uses installed Pi/TUI
1.5.0. Earlier compatible versions are not separately runtime-tested.

- Public `registerShortcut`, `registerCommand`, `ui.custom`, `Input`, session
  `getEntries`, and `ui.setEditorText` APIs implement search. No private patch or
  terminal-input listener is installed. Pi routes extension shortcuts through the
  focused prompt editor; session-selector Ctrl+R rename keeps its own handler.
  Another extension registering Ctrl+R can still conflict; `/prompt-history` is
  the fallback. Disabled search does not install an overlay; arrow recall remains.
- Current-session `getEntries()` includes all saved branches and not-yet-flushed
  user messages. `message_end` refreshes live entries while the picker is open.
  Arrow recall still uses only `getBranch()` and its existing trimming policy.
- Pi's public read-only session manager exposes the effective session directory,
  not a configurable storage-root getter. The adapter recognizes a directory
  directly below `getAgentDir()/sessions` as the default profile layout and scans
  its siblings. Otherwise it scans only the effective custom session directory.
  Discovery includes flat JSONL files and one level of project directories,
  matching Pi's storage layout; it does not follow directory/file symlinks or
  look for arbitrary sessions elsewhere. A foreign explicitly opened session
  remains confined to its effective directory, never the current user's other roots.
- Session headers supply recorded cwd. Git resolution is argv-based, realpath
  canonicalized, cached per picker, and limited to a 1.5-second subprocess.
  Worktrees are distinct; failures retain a deterministic local identity.
- Four concurrent file reads/parsers maximum; directories visited serially.
  Reads use AbortSignal, and every publication is generation-guarded. In-flight
  Git resolution may finish after close (maximum 1.5 seconds) but cannot publish.
  JSON parsing is per asynchronously read file, not streaming within a file.
  An exceptionally large single transcript can briefly occupy the JS thread.
- No transcript cache or second persistent store is created. Each opening/scope
  change rescans files, so same-size/same-mtime rewrites are seen on the next scan.
  External file edits during a completed open are not watched; reopen or cycle
  scope to refresh them. Unreadable/corrupt files produce aggregate UI counts,
  never prompt/error values. Storage-root failure explicitly reports live-only.
- Matching is Unicode lowercase, whitespace-normalized literal token AND, not
  fuzzy search. Display dedup happens after scope filtering. Text and provenance
  remain intact internally. Safe snippets/preview replace control and format
  characters and use terminal-width wrapping/truncation. Substring highlighting
  is not implemented in v1; no fuzzy/highlighting claim is made.
- The bounded stacked preview is navigable using Ctrl+Up/Ctrl+Down; paging applies
  to results. Extremely short terminals prioritize the footer and cannot display
  every pane simultaneously. Narrow terminals clip the full footer hints.
- Cancel never calls an editor setter, so the host draft, cursor, paste metadata,
  and attachments are untouched. Acceptance uses public `setEditorText` only;
  stock Pi 1.5.0's `Editor.setText` clears collapsed-paste metadata. Images are
  not reattached: this is text-only recall. Pi owns text normalization and custom
  editor implementations; the extension cannot guarantee a third-party editor's
  attachment behavior. Clipboard images in Pi 1.5.0 are paths in the editor.
- Saved user text can already contain expanded skill content or transformations
  performed by Pi/other extensions. Pi session records do not preserve a separate
  reliably correlated original-composer field. Search does not invent an original
  version or ingest assistant/tool/custom entries. This is an explicit host-data
  limitation, not a claim to reconstruct pre-expansion input.
- Settings load once at first search use per session; reload/new session resets
  settings and owned resources. Scope cycling never writes settings. The identifier
  is `pi-prompt-history`, following Pi's existing settings filename convention.
  The settings generator rejects an explicit example identical to defaults, so
  the requested project example is documented outside its generated region.

## Verification record

Commands and outcomes are recorded below after execution. All prompt/settings
fixtures are synthetic and isolated; no personal history or user config is read.
The initial type/lint run was interrupted by a host-wide OOM (reported by user).
Subsequent checks use sequential commands and `VITEST_MAX_WORKERS=1`.

The supervisor verified the worker launch as `openai-codex/gpt-6.1-sol`,
reasoning medium. No workers were spawned by this replacement worker. No checkout
commit, publish, live Pi reload, user-config write, or change to pre-existing
untracked `bun.lock` is made.

### Replacement-worker verification (2026-11-04)

Only fixture test timeouts changed during finalization: Git/file integration tests
now explicitly allow 60 seconds, retaining every assertion. Runtime feature code
was not rewritten. Focused tests were run sequentially with `--maxWorkers=1`.

- `npx vitest run extensions/pi-prompt-history/test --maxWorkers=1`: exit 0,
  5 files / 15 tests passed, 6.13 seconds. Includes existing arrow recall tests.
  Evidence: `.cache/prompt-history/focused-final.log`.
- `node .cache/prompt-history/tui-smoke.mjs`: exit 0 in a real Pi 1.5.0 PTY,
  using synthetic sessions, temporary HOME/agent/session directories, offline mode
  and a preload blocking socket connections. Verified actual Ctrl+R project
  search, Ctrl+S global scope, Escape preserving the draft, reopen resetting to
  project, Tab copying both original lines without submitting, and session-picker
  Ctrl+R opening Rename Session rather than prompt history. No smoke correction
  was needed. Evidence: `.cache/prompt-history/tui-smoke.log`,
  `tui-evidence.json` (eight captured screen boundaries), and `tui-raw.log`.
- `npx oxfmt --check extensions/pi-prompt-history` and
  `npx oxlint --type-aware extensions/pi-prompt-history`: passed.
  Evidence: `.cache/prompt-history/scoped-final.log` (the subsequent settings
  invocation failed because `--package` is unsupported, not a feature failure).
- `node packages/pi-extension-settings/dist/cli-entry.js check --root
extensions/pi-prompt-history`: passed, one package current.
  Evidence: `.cache/prompt-history/scoped-final-retry.log`. Its subsequent direct
  TypeScript invocation required TypeScript 7's `--ignoreConfig`; see final
  type/pack evidence below rather than treating that invocation as a pass.
- `npx tsc --ignoreConfig --noEmit --target ES2022 --module NodeNext
--moduleResolution NodeNext --strict --skipLibCheck --allowImportingTsExtensions
--types node extensions/pi-prompt-history/src/*.ts
extensions/pi-prompt-history/test/*.ts`: exit 0 (extension-scoped strict types).
  `npm pack --dry-run -w @zigai/pi-prompt-history`: exit 0; all 14 package files,
  including schema, generated settings, and both documents, included.
  Evidence: `.cache/prompt-history/types-pack-final.log`.
- Prior `.cache/prompt-history/root-check-complete.log` confirms root tests:
  142 files passed / one skipped, 1,072 tests passed / one skipped; package
  consumers including prompt-history passed, followed by package verification.
  It stops during `pi-codex-core` workspace tests. No remaining check process for
  this checkout was found, and no exit status was recoverable. **Full `npm run
check` success is not established.** An observed active check belonged to the
  separate `/home/fedora/.cache/pi-verification-20261104/public` checkout; it was
  neither duplicated nor interrupted. No expensive root check was restarted.
- Supervisor-reported independent Pi/OMP parity: 1,201 synthetic fixtures,
  18 queries passed. This is lead evidence, not a replacement-worker rerun.

Runtime limits remain as documented above, including no substring highlighting,
bounded non-streaming transcript parsing, and text-only acceptance. No personal
history/config was read, no worker spawned, no commit made, no live reload done,
and no unrelated changes or original untracked `bun.lock` modified.
