import { Type } from "typebox";

import { defineExtensionSettings } from "../src/definition.ts";

export function testDefinition() {
    return defineExtensionSettings({
        id: "pi-example",
        title: "Pi Example",
        description: "Settings for the Pi example extension.",
        schemaId: "https://example.test/pi-example/config.schema.json",
        schema: Type.Object(
            {
                enabled: Type.Boolean({
                    default: true,
                    description: "Enable the extension.",
                }),
                mode: Type.Union([Type.Literal("compact"), Type.Literal("expanded")], {
                    default: "compact",
                    description: "Display mode.",
                }),
                appearance: Type.Object(
                    {
                        color: Type.String({
                            default: "blue",
                            description: "Accent color.",
                        }),
                        opacity: Type.Number({
                            minimum: 0,
                            maximum: 1,
                            default: 0.8,
                            description: "Accent opacity.",
                        }),
                    },
                    { default: {}, additionalProperties: false },
                ),
                tools: Type.Array(Type.String(), {
                    default: ["read"],
                    description: "Enabled tool names.",
                }),
            },
            { additionalProperties: false },
        ),
    });
}
