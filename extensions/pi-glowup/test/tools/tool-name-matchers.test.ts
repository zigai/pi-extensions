import { describe, expect, it } from "vitest";
import { shouldPreserveThirdPartyToolRenderer } from "../../src/tools/renderers.ts";
import type { ThirdPartyToolRenderingOptions } from "../../src/tools/types.ts";

function preserves(toolName: string, renderingOptions: ThirdPartyToolRenderingOptions): boolean {
    return shouldPreserveThirdPartyToolRenderer({
        toolName,
        toolDefinition: undefined,
        renderingOptions,
    });
}

describe("tool preservation policies", () => {
    it("matches exact full and base names without matching substrings", () => {
        expect(preserves("owner__rich_tool", { preserveTools: ["rich_tool"] })).toBe(true);
        expect(preserves("owner__rich_tool", { preserveTools: ["owner__rich_tool"] })).toBe(true);
        expect(preserves("owner__rich_tool", { preserveTools: ["rich"] })).toBe(false);
        expect(preserves("other_tool", { preserveTools: ["rich_tool"] })).toBe(false);
    });

    it("matches patterns against full and base names and resets stateful patterns", () => {
        for (const pattern of [/^rich_tool$/g, /^owner__rich_tool$/y]) {
            const options: ThirdPartyToolRenderingOptions = {
                preserveMatchers: [{ kind: "pattern", pattern }],
            };
            pattern.lastIndex = 7;
            expect(preserves("owner__rich_tool", options)).toBe(true);
            expect(pattern.lastIndex).toBe(0);
            expect(preserves("owner__rich_tool", options)).toBe(true);
            expect(pattern.lastIndex).toBe(0);
            expect(preserves("owner__other_tool", options)).toBe(false);
            expect(pattern.lastIndex).toBe(0);
        }
    });

    it("passes only the original full name to predicates", () => {
        const received: string[] = [];
        const options: ThirdPartyToolRenderingOptions = {
            preserveMatchers: [
                {
                    kind: "predicate",
                    matches: (name) => {
                        received.push(name);
                        return name === "owner__rich_tool";
                    },
                },
            ],
        };
        expect(preserves("owner__rich_tool", options)).toBe(true);
        expect(preserves("rich_tool", options)).toBe(false);
        expect(received).toEqual(["owner__rich_tool", "rich_tool"]);
    });

    it("short-circuits programmatic matchers after exact-name preservation", () => {
        let calls = 0;
        expect(
            preserves("rich_tool", {
                preserveTools: ["rich_tool"],
                preserveMatchers: [
                    {
                        kind: "predicate",
                        matches: () => {
                            calls++;
                            return false;
                        },
                    },
                ],
            }),
        ).toBe(true);
        expect(calls).toBe(0);
        expect(preserves("rich_tool", {})).toBe(false);
    });
});
