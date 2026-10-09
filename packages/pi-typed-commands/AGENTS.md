# AGENTS.md

## Work and Verify

This repository publishes `pi-typed-args`, a TypeScript ESM library for Pi commands and typed skills, not a manifest-registered extension. Read the affected public exports, README, and relevant `docs/` guide before changing contracts. Run `npm run check` before handoff; it checks formatting, lint, types, and tests.

Keep `package.json` exports and its publish allowlist aligned with `src/`, `schemas/`, and `docs/`. Pi host packages and TypeBox stay peers, with development copies for local checks.

## Module Ownership

- `src/core/index.ts` exposes argument definitions, compilation, parsing, validation, serialization, and help. Keep this layer independent of Pi UI/session behavior.
- `src/command/` and `src/pi/` own command definition/registration and Pi integration; preserve the dedicated `/command` and `/pi` entrypoints.
- `src/skills/` owns skill metadata, normalization, and invocation; keep the published `/schema` aligned with the accepted skill-argument contract.
- `src/pi-tui/` and `src/form/` own form presentation and interaction. Keep inferred types, runtime parsing, completions, help, and forms consistent with the same argument definition. Test observable behavior and public entrypoints.

## Configuration and Sessions

The Pi integration has its own configuration: `src/pi/config-schema.ts`, `settings.ts`, and `presentation-config.ts`. Preserve that architecture and synchronize `config.schema.json` and documented defaults when changing it. Keep session snapshots and cleanup with `ux-session.ts`, `session-state.ts`, and `extension.ts`; do not move configuration I/O into the core parser or rendering paths. Preserve trusted-project checks, existing malformed files, and value-free diagnostics.

This library does not depend on `@zigai/pi-extension-settings`; preserve its current configuration owner. If adopting that dependency as part of a requested change, follow its `docs/manual-setup.md` and `docs/runtime.md`.

Document actual library APIs and supported configuration in README/`docs/`, not hypothetical extension scaffolds. Configuration examples should match real defaults; keep lifecycle implementation guidance here and in tests.
