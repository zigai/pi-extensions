# Platform verification testing

`pi-codex-goal` uses a Crabbox-backed local platform verification gate to prove the package on macOS, Ubuntu Linux, and native Windows before release-sensitive changes ship.

Ordinary hosted CI is owned by the monorepo root and runs shared and per-workspace checks on Node 24 for push and pull request checks. It does not run this Crabbox release matrix, lease targets, secrets, or model-backed platform verification.

Run the commands below from `extensions/pi-goal` (or with `npm run <task> -w pi-codex-goal` at the repository root). Crabbox synchronizes the entire monorepo from its root, then changes into this workspace on each target. Root `.crabboxignore` must exclude secrets, dependency trees, and generated verification/build artifacts throughout the repository.

This setup reuses the portable Crabbox platform-testing lessons without copying provider-specific verification flows from another project. The gate includes a real model-backed pi run so release checks catch platform-specific extension failures before completion is claimed.

## Required gate

Release-sensitive changes use a doctor-first gate:

```sh
npm run check:platform-verification
npm run verify:platform:doctor
npm run verify:platform:all
```

`verify:platform:all` runs the same doctor before any target suite starts, so a full release run still fails before syncing targets or spending model tokens when local setup is not ready. Run `verify:platform:doctor` directly when diagnosing setup.

Per-target commands are for diagnosis. They run a lightweight local artifact preflight before Crabbox sync, but they do not replace the full doctor readiness check:

```sh
npm run verify:platform:macos
npm run verify:platform:ubuntu
npm run verify:platform:windows-native
```

## Targets

| Target           | Crabbox provider       | Shell contract                          |
| ---------------- | ---------------------- | --------------------------------------- |
| `macos`          | `ssh` static localhost | POSIX shell on macOS                    |
| `ubuntu`         | `local-container`      | POSIX shell in an Ubuntu Node container |
| `windows-native` | `parallels`            | native Windows PowerShell               |

## Required environment

Install Crabbox `0.26.0` or newer with Homebrew so `crabbox` is on `PATH`. Use `PLATFORM_VERIFICATION_CRABBOX=/path/to/crabbox` only when testing a non-default binary. The supported package runtime floor is Node 24, matching the local and Crabbox platform validation baseline.

```sh
PLATFORM_VERIFICATION_MAC_HOST=localhost
PLATFORM_VERIFICATION_MAC_USER="$USER"
PLATFORM_VERIFICATION_MAC_WORK_ROOT="/Users/$USER/crabbox/pi-codex-goal"
PLATFORM_VERIFICATION_UBUNTU_IMAGE="cimg/node:24.16"

PLATFORM_VERIFICATION_WINDOWS_VM="pi-extension-windows-template"
PLATFORM_VERIFICATION_WINDOWS_SNAPSHOT="crabbox-ready"
PLATFORM_VERIFICATION_WINDOWS_USER="<windows-ssh-user>"
PLATFORM_VERIFICATION_WINDOWS_WORK_ROOT="C:\\crabbox\\pi-codex-goal"

# Real runtime verification defaults.
PLATFORM_VERIFICATION_MODEL="zai/glm-5.2"
PLATFORM_VERIFICATION_AUTH_ENV="ZAI_API_KEY,Z_AI_API_KEY"
```

`platform-verification.config.mjs` owns the project defaults: required targets/suites, Crabbox minimum version, Ubuntu image, macOS work root, shared Parallels template/snapshot, Node validation major, default model, and explicit auth env names. Use `PLATFORM_VERIFICATION_*` variables only as local machine knobs or one-off overrides.

Use `PLATFORM_VERIFICATION_MODEL` to run the real runtime verification against another provider/model, and `PLATFORM_VERIFICATION_AUTH_ENV` to tell Crabbox which auth variables to forward to each target. Do not broad-allow secrets; forward only the named variables needed by `goal-runtime-verification`.

The doctor fails when any required platform setup is missing. It verifies the Crabbox binary/version, `ssh`, `local-container`, and `parallels` provider availability, provider-specific readiness, Docker, macOS SSH, Windows source VM/snapshot state, artifact-root writability, forbidden source/package artifacts, and model auth presence. It also fails when the real runtime verification suite is required and none of the configured model auth environment variables is present. Doctor does not install missing target tools; reusable tool drift should be fixed in the local target image/template.

Local `.env` / `.env.*` files and packed `.tgz` artifacts are forbidden at the repository top level. They are ignored by both Git and Crabbox sync, and the platform-verification `run` command rejects them before target sync so diagnostic per-target runs cannot forward local secrets accidentally.

For Windows, `pi-extension-windows-template` must be stopped and `crabbox-ready` must be a known-good power-off snapshot. Standalone doctor warms a disposable Crabbox clone when the stopped template has no live IP, then probes `node`, `npm`, `git`, `tar`, and SSH identity. The full `verify:platform:all` gate skips that disposable doctor probe because the immediately following Windows target run validates the same SSH/tool path on the real test lease. If a reusable Windows tool is missing, update the template and refresh/promote `crabbox-ready`; do not add one-off installers to per-run verification scripts.

## What the suites prove

Each required target runs `platform-build` and `goal-runtime-verification`.

### `platform-build`

1. Verify Node major version is at least the configured Node 24 validation baseline.
2. Run `npm ci` at the synced monorepo root, using its shared lockfile.
3. Run root `npm run build` to build shared runtime dependencies, then workspace `npm run verify`.
4. Pack this workspace and its built local settings, Glowup, and typed-args dependencies. The packages keep normal exact runtime dependency declarations, not bundled workspace sources.
5. Create a clean target-local pi project.
6. Install those tarballs into that project with `npm install --ignore-scripts --no-save`, so the check exercises the current local dependency closure rather than registry copies.
7. Run `pi install -l ./node_modules/pi-codex-goal --approve` from the clean project so Pi 0.79+ can read and write project-local package settings for this isolated command.
8. Run the resolved SDK CLI with an isolated `PI_CODING_AGENT_DIR` for both install and list; run `pi list --approve` and assert `pi-codex-goal` is registered from the packed install.
9. Assert the verification never used the source shortcut `pi -e .` or `pi --extension .`.

### `goal-runtime-verification`

1. Re-pack and install this workspace and its local runtime dependency tarballs into a clean target-local pi project.
2. Run real `pi --approve --model <model> -p <prompt>` against that packed install so non-interactive Pi 0.79+ loads the isolated project-local package settings.
3. Prompt the model to call the actual goal tools, create a marker file, verify it with the built-in `read` tool, call `update_goal`, and confirm completion.
4. Capture pi stdout/stderr and session JSONL.
5. Assert the final marker, verified file, `pi-codex-goal` custom entries, built-in `read` tool evidence, and complete goal status.

## Interactive `/goal` verification

The model-backed platform verification exercises goal tools through non-interactive `pi -p`; it does not
prove the real TUI slash-command submission path. Release-sensitive changes that affect command
parsing, TUI submission, goal command behavior, hidden continuation, or post-tool completion must
also record manual interactive evidence.

The evidence record must include the submitted command, model, session directory, final assistant
evidence, and confirmation that the session JSONL contains the `/goal` command path, filesystem
verification, and `update_goal` completion.

Pi must be able to authenticate to a capable model. Start a clean interactive session from the
repository:

```sh
rm -f /tmp/pi-codex-goal-fast.txt /tmp/pi-codex-goal-slash-verification.txt
rm -rf /tmp/pi-codex-goal-slash-verification-session
pi --model <model-id> --session-dir /tmp/pi-codex-goal-slash-verification-session
```

For a fast command-path check, submit:

```text
/goal Create /tmp/pi-codex-goal-fast.txt containing PI_GOAL_FAST_OK; verify with cat; mark complete; report final status.
```

Expected evidence:

```text
Verified file path: /tmp/pi-codex-goal-fast.txt
Verified content: PI_GOAL_FAST_OK
Final goal status: complete
```

For a fuller path that requires goal inspection and filesystem verification, submit:

```text
/goal Create /tmp/pi-codex-goal-slash-verification.txt containing PI_GOAL_SLASH_OK, verify the file content from the filesystem, inspect the current goal, and mark the goal complete only after verification. Final reply must include the verified file path, verified content, and final goal status.
```

Expected evidence:

```text
Verified file path: /tmp/pi-codex-goal-slash-verification.txt
Verified content: PI_GOAL_SLASH_OK
Final goal status: complete
```

`/goal` is an interactive editor command. Do not use `pi -p '/goal ...'` as a slash-command verification;
print mode sends an initial model prompt instead of reliably exercising editor command submission.
For headless checks, prompt the model to call `create_goal`, `get_goal`, and `update_goal` directly.

For tmux automation, send the prompt as literal text and submit with CSI-u Enter (`ESC [ 13 u`):

```sh
tmux send-keys -t "$TMUX_SESSION" -l '/goal Create /tmp/pi-codex-goal-fast.txt containing PI_GOAL_FAST_OK; verify with cat; mark complete; report final status.'
tmux send-keys -t "$TMUX_SESSION" -l $'\033[13u'
```

Normal `tmux send-keys Enter` works in many environments, but CSI-u Enter is the robust scripted
path through Pi's TUI key parser. The fast prompt intentionally uses shell `cat`; require the
built-in `read` tool when that path is under test.

If a run remains on `Working...` after a built-in `read` result, capture the session JSONL and TUI
pane before retrying. A healthy read-verification path contains a `toolName: "read"` result, an
`update_goal` result with `status: "complete"`, and a final assistant message. If only the TUI path
stalls, treat it as a Pi host/tool-resume reproduction until evidence points to goal continuation.

## Artifact contract

Every target writes artifacts under:

```text
.artifacts/platform-verification/<run-id>/<target>/<suite>/
```

Required files include:

```text
summary.json
artifact-manifest.json
target.json
suite.json
command.txt
exit-code.txt
crabbox.stdout.txt
crabbox.stderr.txt
crabbox.timing.json
node-version.txt
packed-tarball.txt
packed-node-install.stdout.txt
packed-node-install.stderr.txt
pi-install.stdout.txt
pi-install.stderr.txt
pi-list.stdout.txt
pi-list.stderr.txt
assertions.json
failures.md            # only when assertions fail
```

`goal-runtime-verification` also writes `goal-runtime-result.json`, `pi-run.stdout.txt`, `pi-run.stderr.txt`, and `session.jsonl`.

The suites record failures as artifacts before reporting failure so the host can inspect the real target evidence. If a multi-suite target run fails before any suite starts, it writes a `warmup-failure` artifact directory with Crabbox stdout/stderr, timing, exit-code, and assertion evidence. `target.json` records the Crabbox provider, target, work root, and image/template identifiers used for the run. Each target also writes a `lease-cleanup` artifact directory with `crabbox.stop.*` files; cleanup failure is a failing test result. Ubuntu and Windows runs also invoke Crabbox cleanup for stale provider-owned state after stopping the owned lease. Static macOS SSH cleanup remains host-owned because Crabbox can only remove its local claim there.

## Lessons carried forward

- Treat Crabbox as the lease/sync/run layer; this repo owns the assertions that make a run meaningful.
- Use Crabbox targets instead of a one-OS local script.
- Keep `platform-build` behavior in the shared Node orchestrator; native Windows may use only a thin PowerShell wrapper to launch it.
- Run the repository's existing validation command on every required target.
- Test the packed package, not `pi -e .`.
- Pass `--approve` for isolated project-local package verification commands and non-interactive runtime verifications; Pi 0.79+ otherwise skips project-local settings and packages when no saved trust decision exists.
- Include a real model-backed pi run so release claims are not based on unit tests alone.
- Assert built-in `read` evidence in the model-backed runtime verification so post-tool goal completion stays covered.
- Keep project-specific defaults in `platform-verification.config.mjs`; use environment variables only for local overrides.
- Make doctor fail before expensive or long target runs, and enforce doctor-before-all in the release entrypoint.
- Preserve artifacts on failure and use `assertions.json` as the pass/fail source of truth.
- Record lease stop evidence for every target and fail cleanup problems.
- Treat missing platform setup as blocked, not skipped-ready.
- Redact persisted artifacts and fail scans that find raw secret values.

## Source of truth

- Config: [`platform-verification.config.mjs`](../platform-verification.config.mjs)
- Sync exclusions: [`.crabboxignore`](../.crabboxignore)
- CLI: [`scripts/platform-verification.mjs`](../scripts/platform-verification.mjs)
- Target commands: [`scripts/platform-verification/targets.mjs`](../scripts/platform-verification/targets.mjs)
- Platform-build suite body: [`scripts/platform-verification/platform-build.mjs`](../scripts/platform-verification/platform-build.mjs)
- Windows wrapper: [`scripts/platform-verification/platform-build-windows.ps1`](../scripts/platform-verification/platform-build-windows.ps1)
