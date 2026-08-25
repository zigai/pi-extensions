# Runtime loading and updates

Pi Extension Settings separates authoring-time schema work from the code loaded by Pi.

| Import                                 | Use it for                                                        |
| -------------------------------------- | ----------------------------------------------------------------- |
| `@zigai/pi-extension-settings`         | Defining and generating settings in Node.js authoring tools       |
| `@zigai/pi-extension-settings/runtime` | Hydrating the checked-in prevalidation artifact in extension code |
| `@zigai/pi-extension-settings/pi`      | Loading and updating settings through Pi paths and project trust  |

## Load settings

```ts
import { loadPiExtensionSettings } from "@zigai/pi-extension-settings/pi";
import settingsDefinition from "./settings.ts";

const loaded = loadPiExtensionSettings(settingsDefinition, ctx, {
  bundledSchema: {
    kind: "url",
    url: new URL("../config.schema.json", import.meta.url),
  },
});
```

Resolution applies layers in this order:

1. Schema defaults.
2. Global settings.
3. Trusted-project settings.

Objects merge recursively. Arrays and scalar values replace earlier values. Invalid layers are ignored and reported through `loaded.diagnostics` without exposing their values.

Global settings are stored under Pi's agent directory at `extension-settings/<id>.json`. Trusted-project overrides use `<project>/<Pi config directory>/extension-settings/<id>.json`. `getPiGlobalSettingsPath()` and `getPiProjectSettingsPath()` return the resolved paths.

Loading installs or refreshes the generated editor schema and creates a missing global settings file. It never overwrites an existing settings file and never creates a project settings file.

Keep module import and the extension factory free of settings I/O. Load at most once per session, at the first lifecycle event that needs settings. Pi-level package configuration is the appropriate zero-load switch when an extension should not be imported at all.

## Update settings safely

Use `updatePiExtensionSettings()` instead of writing settings files directly. Load first so the generated editor schema is installed and verified.

```ts
import { updatePiExtensionSettings } from "@zigai/pi-extension-settings/pi";

const result = await updatePiExtensionSettings(settingsDefinition, ctx, {
  scope: "global",
  update: (current) => ({ ...current, enabled: false }),
});

if (result.status !== "updated" && result.status !== "unchanged") {
  ctx.ui.notify(result.message, "error");
}
```

The synchronous callback receives the latest encoded layer and runs once while the settings file is locked. The package validates the returned layer by itself and after resolution, then publishes it atomically. Invalid existing files and invalid updates remain untouched. Project updates require a trusted project and may create its missing settings file.

For an editor based on a previously loaded snapshot, pass `globalRevision` or `projectRevision` as `expectedRevision`. A stale revision returns `conflict`. Omit it for semantic updates that should apply to the latest valid layer.
