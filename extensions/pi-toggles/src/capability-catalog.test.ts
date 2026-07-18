import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildCapabilityCatalog } from "./capability-catalog.ts";

const sourceInfo = {
    source: "test-package",
    scope: "user",
    origin: "package",
    path: "resource.md",
} as const;

describe("buildCapabilityCatalog", () => {
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
