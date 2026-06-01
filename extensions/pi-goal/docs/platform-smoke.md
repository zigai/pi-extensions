# Platform smoke testing

`pi-codex-goal` uses a Crabbox-backed local platform smoke gate to prove the package on macOS, Ubuntu Linux, and native Windows before release-sensitive changes ship.

This setup reuses the portable Crabbox platform-testing lessons without copying provider-specific smoke flows from another project. The gate includes a real model-backed pi run so release checks catch platform-specific extension failures before completion is claimed.

## Required gate

Run the cheap harness checks first, then the required full gate:

```sh
npm run check:platform-smoke
npm run smoke:platform:all
```

`smoke:platform:all` runs `smoke:platform:doctor` before any target suite starts. Use `smoke:platform:doctor` directly when diagnosing local setup without spending model tokens.

Per-target commands are for diagnosis:

```sh
npm run smoke:platform:macos
npm run smoke:platform:ubuntu
npm run smoke:platform:windows-native
```

## Targets

| Target | Crabbox provider | Shell contract |
| --- | --- | --- |
| `macos` | `ssh` static localhost | POSIX shell on macOS |
| `ubuntu` | `local-container` | POSIX shell in an Ubuntu Node container |
| `windows-native` | `parallels` | native Windows PowerShell |

## Required environment

Install Crabbox with Homebrew so `crabbox` is on `PATH`. Use `PLATFORM_SMOKE_CRABBOX=/path/to/crabbox` only when testing a non-default binary.

```sh
PLATFORM_SMOKE_MAC_HOST=localhost
PLATFORM_SMOKE_MAC_USER="$USER"
PLATFORM_SMOKE_MAC_WORK_ROOT="/Users/$USER/crabbox/pi-codex-goal"
PLATFORM_SMOKE_UBUNTU_IMAGE="cimg/node:24.16"

PLATFORM_SMOKE_WINDOWS_VM="pi-extension-windows-template"
PLATFORM_SMOKE_WINDOWS_SNAPSHOT="crabbox-ready"
PLATFORM_SMOKE_WINDOWS_USER="<windows-ssh-user>"
PLATFORM_SMOKE_WINDOWS_WORK_ROOT="C:\\crabbox\\pi-codex-goal"

# Real runtime smoke defaults.
PLATFORM_SMOKE_MODEL="zai/glm-5.1"
PLATFORM_SMOKE_AUTH_ENV="ZAI_API_KEY,Z_AI_API_KEY"
```

Use `PLATFORM_SMOKE_MODEL` to run the real runtime smoke against another provider/model, and `PLATFORM_SMOKE_AUTH_ENV` to tell Crabbox which auth variables to forward to each target.

The doctor fails when any required platform setup is missing. It verifies the Crabbox binary/version, `ssh`, `local-container`, and `parallels` provider availability, provider-specific readiness, Docker, macOS SSH, Windows source VM/snapshot state, artifact-root writability, forbidden source/package artifacts, and model auth presence. It also fails when the real runtime smoke suite is required and none of the configured model auth environment variables is present.

For Windows, `pi-extension-windows-template` must be stopped and `crabbox-ready` must be a known-good power-off snapshot. If a reusable Windows tool is missing, update the template and refresh/promote `crabbox-ready`; do not add one-off installers to per-run smoke scripts.

## What the suites prove

Each required target runs `platform-build` and `goal-runtime-smoke`.

### `platform-build`

1. Verify Node major version is at least the configured validation baseline.
2. Run `npm ci` in the synced checkout.
3. Run `npm run verify`, the repo's local CI command.
4. Run `npm pack`.
5. Create a clean target-local pi project.
6. Install the packed tarball into that project with `npm install --no-save`.
7. Run `pi install -l ./node_modules/pi-codex-goal` from the clean project.
8. Run `pi list` and assert `pi-codex-goal` is registered from the packed install.
9. Assert the smoke never used the source shortcut `pi -e .` or `pi --extension .`.

### `goal-runtime-smoke`

1. Re-pack and install the package into a clean target-local pi project.
2. Run real `pi --model <model> -p <prompt>` against that packed install.
3. Prompt the model to call the actual goal tools, create and verify a marker file, call `update_goal`, and confirm completion.
4. Capture pi stdout/stderr and session JSONL.
5. Assert the final marker, verified file, `pi-codex-goal` custom entries, and complete goal status.

## Artifact contract

Every target writes artifacts under:

```text
.artifacts/platform-smoke/<run-id>/<target>/<suite>/
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

`goal-runtime-smoke` also writes `goal-runtime-result.json`, `pi-run.stdout.txt`, `pi-run.stderr.txt`, and `session.jsonl`.

The suites record failures as artifacts before reporting failure so the host can inspect the real target evidence. Each target also writes a `lease-cleanup` artifact directory with `crabbox.stop.*` files; cleanup failure is a failing test result. Ubuntu and Windows runs also invoke Crabbox cleanup for stale direct-provider state after stopping the owned lease.

## Lessons carried forward

- Use Crabbox targets instead of a one-OS local script.
- Keep platform-specific shell rendering explicit: POSIX for macOS/Ubuntu and PowerShell for native Windows.
- Run the repository's existing validation command on every required target.
- Test the packed package, not `pi -e .`.
- Include a real model-backed pi run so release claims are not based on unit tests alone.
- Make doctor fail before expensive or long target runs, and enforce doctor-before-all in the release entrypoint.
- Preserve artifacts on failure and use `assertions.json` as the pass/fail source of truth.
- Record lease stop evidence for every target and fail cleanup problems.
- Treat missing platform setup as blocked, not skipped-ready.
- Redact persisted artifacts and fail scans that find raw secret values.

## Source of truth

- Config: [`platform-smoke.config.mjs`](../platform-smoke.config.mjs)
- CLI: [`scripts/platform-smoke.mjs`](../scripts/platform-smoke.mjs)
- Target commands: [`scripts/platform-smoke/targets.mjs`](../scripts/platform-smoke/targets.mjs)
- Windows suite body: [`scripts/platform-smoke/platform-build-windows.ps1`](../scripts/platform-smoke/platform-build-windows.ps1)
