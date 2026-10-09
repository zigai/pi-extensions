import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { createSlashSkillFilter } from "../src/slash-skill-filter.ts";

const options = { signal: new AbortController().signal };

describe("slash skill filter", () => {
    it("removes skill commands from slash suggestions and delegates completion", async () => {
        const applyCompletion = vi.fn(() => ({ lines: ["/help"], cursorLine: 0, cursorCol: 5 }));
        const current: AutocompleteProvider = {
            triggerCharacters: ["/"],
            getSuggestions: vi.fn(async () => ({
                prefix: "/",
                items: [
                    { value: "skill:typescript", label: "skill:typescript" },
                    { value: "help", label: "help" },
                ],
            })),
            applyCompletion,
        };
        const filtered = createSlashSkillFilter(current);

        await expect(filtered.getSuggestions(["/"], 0, 1, options)).resolves.toEqual({
            prefix: "/",
            items: [{ value: "help", label: "help" }],
        });
        const item = { value: "help", label: "help" };
        expect(filtered.applyCompletion(["/"], 0, 1, item, "/")).toEqual({
            lines: ["/help"],
            cursorLine: 0,
            cursorCol: 5,
        });

        expect(applyCompletion).toHaveBeenCalledWith(["/"], 0, 1, item, "/");
    });

    it("returns null when every slash suggestion is a skill", async () => {
        const current: AutocompleteProvider = {
            triggerCharacters: ["/"],
            getSuggestions: async () => ({
                prefix: "/skill:",
                items: [{ value: "skill:typescript", label: "skill:typescript" }],
            }),
            applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
        };

        await expect(
            createSlashSkillFilter(current).getSuggestions(["/skill:"], 0, 7, options),
        ).resolves.toBeNull();
    });
});
