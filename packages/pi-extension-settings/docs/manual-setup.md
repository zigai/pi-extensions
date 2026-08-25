# Add settings to an existing Pi extension

This guide adds typed settings to an existing TypeScript Pi extension. For a new extension, [Pi Extension Template](https://github.com/zigai/pi-extension-template) generates this structure for you.

## 1. Install the package

```sh
npm install @zigai/pi-extension-settings
```

## 2. Define the settings

Keep authoring-only schema code in `src/settings-input.ts`. The generator imports this file, so it must not import Pi runtime code or the generated prevalidation artifact.

```ts
import type { ExtensionSettingsDefinitionInput } from "@zigai/pi-extension-settings";
import { Type } from "typebox";

export const settingsSchema = Type.Object(
  {
    enabled: Type.Boolean({
      default: true,
      description: "Enable the extension's behavior.",
    }),
    excludedTools: Type.Array(Type.String(), {
      default: [],
      description: "Tool names the extension should ignore.",
    }),
  },
  { additionalProperties: false },
);

const settingsInput = {
  id: "pi-example",
  title: "Pi Example",
  description: "Settings for Pi Example.",
  schemaId: "https://raw.githubusercontent.com/zigai/pi-example/main/config.schema.json",
  schema: settingsSchema,
} as const satisfies ExtensionSettingsDefinitionInput<typeof settingsSchema>;

export default settingsInput;
```

## 3. Configure generation

Add the settings manifest and commands to `package.json`:

```json
{
  "piExtensionSettings": {
    "definition": "./src/settings-input.ts",
    "prevalidation": "./src/settings.prevalidated.ts"
  },
  "scripts": {
    "config:generate": "pi-extension-settings generate",
    "config:check": "pi-extension-settings check"
  }
}
```

The generated schema and README paths default to `config.schema.json` and `README.md`. Set `schema` or `readme` in the manifest only when those defaults do not fit the package.

If `package.json` uses a `files` allowlist, publish both manifest targets. Including `src` is sufficient; a bundled package can include `src/settings-input.ts` and `src/settings.prevalidated.ts` explicitly.

Generate the initial artifacts:

```sh
npm run config:generate
```

Commit the generated `config.schema.json`, `src/settings.prevalidated.ts`, and README settings section. See [Generated artifacts and commands](generation.md) for command behavior, workspace discovery, manifest options, and automation guidance.

## 4. Create the runtime loader

Keep the runtime definition and loader in `src/settings.ts`:

```ts
import { loadPiExtensionSettings, type PiSettingsContext } from "@zigai/pi-extension-settings/pi";
import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";
import type { StaticDecode } from "typebox";

import artifact from "./settings.prevalidated.ts";
import settingsInput, { settingsSchema } from "./settings-input.ts";

export type ExtensionSettings = StaticDecode<typeof settingsSchema>;

export const settingsDefinition = definePrevalidatedExtensionSettings(settingsInput, artifact);

export function loadExampleSettings(ctx: PiSettingsContext) {
  return loadPiExtensionSettings(settingsDefinition, ctx, {
    bundledSchema: { kind: "url", url: new URL("../config.schema.json", import.meta.url) },
  });
}
```

Use `StaticDecode`, not `Static`, for values after TypeBox codecs run.

Do not load settings during module import or the extension factory. Resolve them once per session at the first lifecycle event that needs them. See [Runtime loading and updates](runtime.md) for lifecycle guidance, merge behavior, diagnostics, and transactional writes.
