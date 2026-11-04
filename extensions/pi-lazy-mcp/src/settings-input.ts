import type { ExtensionSettingsDefinitionInput } from "@zigai/pi-extension-settings";
import { Type } from "typebox";

export const settingsSchema = Type.Object(
    {
        idle: Type.Record(
            Type.String(),
            Type.Integer({
                minimum: 1,
                maximum: 2147483647,
            }),
            {
                default: {},
                description:
                    "Milliseconds of idleness after which to stop a server, by server name. Set only for restart-safe servers; active calls and residency capabilities prevent eviction. Unlisted servers stay connected once started.",
            },
        ),
    },
    { additionalProperties: false },
);

const settingsInput = {
    id: "pi-lazy-mcp",
    title: "Pi Lazy MCP",
    description: "Stop idle MCP servers that were started on demand.",
    schemaId:
        "https://raw.githubusercontent.com/zigai/pi-tweaks/master/extensions/pi-lazy-mcp/config.schema.json",
    schema: settingsSchema,
    exampleSettings: {
        idle: { sample: 600000 },
    },
} satisfies ExtensionSettingsDefinitionInput<typeof settingsSchema>;

export default settingsInput;
