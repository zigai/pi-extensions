import type { SlashCommandInfo, ToolExposure } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildCapabilityCatalog } from "./capability-catalog.ts";

const sourceInfo = {
    source: "test-package",
    scope: "user",
    origin: "package",
    path: "resource.md",
} as const;

describe("buildCapabilityCatalog", () => {
    it.each([
        ["direct", "inactive", true],
        ["model-only", "inactive", true],
        ["codemode", "active", true],
        ["deferred", "active", true],
        ["hidden", "unavailable", false],
    ] as const)(
        "reports undeclared %s tools by reachability",
        (exposure: ToolExposure, observedState, supported) => {
            const catalog = buildCapabilityCatalog({
                tools: [
                    { name: "probe", description: "Probe", parameters: {}, exposure, sourceInfo },
                ],
                activeToolNames: new Set(),
                commands: [],
                promptFragments: [],
            });

            expect(catalog[0]).toMatchObject({
                observedState,
                supported,
                exposure,
                declared: false,
            });
        },
    );
    it("includes skills and extension slash commands but excludes prompt templates", () => {
        const commands: SlashCommandInfo[] = [
            { name: "deploy", source: "extension", sourceInfo },
            { name: "skill:review", source: "skill", sourceInfo },
            { name: "template", source: "prompt", sourceInfo },
        ];

        const catalog = buildCapabilityCatalog({
            tools: [],
            activeToolNames: new Set(),
            commands,
            promptFragments: [],
        });

        expect(catalog.map(({ kind, name }) => `${kind}:${name}`)).toEqual([
            "command:deploy",
            "skill:review",
        ]);
        expect(catalog.find((capability) => capability.kind === "skill")?.supported).toBe(true);
    });
});
