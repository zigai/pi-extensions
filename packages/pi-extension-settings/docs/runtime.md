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

### Choose the activation boundary

Keep module import and the extension factory free of settings I/O. Treat `session_start` as the reset boundary and load settings once in the first callback that needs them. If the feature genuinely begins during `session_start`, that handler is the correct activation boundary.

Cache the load result inside the extension factory. A cached result means loading is complete even when `enabled` is false; no separate activation flag is needed. Call the same getter from each tool execution, command, shortcut, or event handler that needs settings. Keep additional extension-specific validation with that getter and cache rejected results too.

```ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadExampleSettings, type ExtensionSettings } from "./settings.ts";

export default function extension(pi: ExtensionAPI): void {
  let loaded: ReturnType<typeof loadExampleSettings> | undefined;

  function getSettings(ctx: ExtensionContext): ExtensionSettings | undefined {
    if (loaded === undefined) {
      loaded = loadExampleSettings(ctx);
      if (ctx.hasUI) {
        for (const diagnostic of loaded.diagnostics) {
          ctx.ui.notify(diagnostic.message, diagnostic.severity);
        }
      }
    }
    return loaded.settings.enabled ? loaded.settings : undefined;
  }

  const reset = () => {
    loaded = undefined;
  };
  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);

  pi.on("before_agent_start", (_event, ctx) => {
    const settings = getSettings(ctx);
    if (settings === undefined) return;

    // Run enabled behavior that needs settings.
  });
}
```

Renderers receive `ToolRenderContext`, not `ExtensionContext`. Keep rendering free of settings I/O and notifications; use presentation data captured during execution or already-owned session state. Renderers must also handle history rendered before settings activation and still return a component.

This moves synchronous settings work from Pi startup to first feature use; it does not eliminate that cost. Pi-level package configuration is the zero-load switch when an extension should not be imported or registered at all. Add cancellation, stale-result rejection, and disposal when the extension acquires asynchronous work or resources that need them.

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
