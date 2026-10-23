import { loadPiExtensionSettings, type PiSettingsContext } from "@zigai/pi-extension-settings/pi";
import { definePrevalidatedExtensionSettings } from "@zigai/pi-extension-settings/runtime";

import settingsInput from "./settings-input.ts";
import artifact from "./settings.prevalidated.ts";
import { checkCatalog } from "./server.ts";

export const settingsDefinition = definePrevalidatedExtensionSettings(settingsInput, artifact);

export function loadLazyMcpSettings(ctx: PiSettingsContext) {
    const loaded = loadPiExtensionSettings(settingsDefinition, ctx, {
        bundledSchema: { kind: "url", url: new URL("../config.schema.json", import.meta.url) },
    });
    const names = new Set<string>();
    for (const server of loaded.settings.servers) {
        if (names.has(server.name)) throw new Error("Pi Lazy MCP has duplicate server names");

        names.add(server.name);
        checkCatalog(server.catalog);

        if (server.transport.type === "http") {
            const url = new URL(server.transport.url);
            if (
                url.username !== "" ||
                url.password !== "" ||
                (url.protocol !== "http:" && url.protocol !== "https:")
            ) {
                throw new Error("MCP HTTP endpoints require HTTP(S) without embedded credentials");
            }
        }
    }

    return loaded;
}
