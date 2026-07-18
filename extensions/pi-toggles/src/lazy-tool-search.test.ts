import { describe, expect, it } from "vitest";
import { rankLazyTools } from "./lazy-tool-search.ts";
import type { PolicyPlan } from "./resolve-capability-policy.ts";

describe("rankLazyTools", () => {
    it("matches lazy tools by searchable argument metadata", () => {
        const plan: PolicyPlan = {
            capabilities: [
                {
                    capability: {
                        id: "tool:write:builtin:write",
                        kind: "tool",
                        name: "write",
                        description: "Create a file",
                        searchText: "filePath destination content",
                        source: {
                            source: "builtin",
                            scope: "user",
                            origin: "top-level",
                            path: "write",
                        },
                        observedState: "inactive",
                        supported: true,
                        protected: false,
                    },
                    desiredState: "lazy",
                    effectiveState: "lazy",
                    trace: [],
                },
            ],
            activeProfiles: new Set(),
            activePromptFragments: [],
            diagnostics: [],
        };

        expect(rankLazyTools(plan, "destination path", 5)).toEqual(["write"]);
    });
});
