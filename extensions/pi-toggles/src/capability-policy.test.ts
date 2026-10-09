import { describe, expect, it } from "vitest";
import { createPolicyConfiguration } from "./capability-policy.ts";
import type { ExtensionSettings, SettingsDocument } from "./settings.ts";

const resolved: ExtensionSettings = {
    enabled: true,
    defaults: { unknownCondition: "no-match", lazyToolLimit: 5, showStatus: true },
    activeProfile: "",
    overrides: [],
    profiles: {},
    promptFragments: [],
    rules: [],
};

describe("createPolicyConfiguration", () => {
    it("drops broad overrides, invalid states, and duplicate definitions with diagnostics", () => {
        const globalDocument: SettingsDocument = {
            overrides: [{ target: { kind: "tool", name: "write" }, state: "off" }],
            profiles: {
                unsafe: {
                    decisions: [{ target: { kind: "command", name: "deploy" }, state: "lazy" }],
                    promptFragments: [],
                },
            },
            rules: [
                {
                    id: "duplicate",
                    priority: 1,
                    when: { fact: "project.trusted", equals: true },
                    decisions: [],
                    activateProfiles: [],
                },
                {
                    id: "duplicate",
                    priority: 2,
                    when: { fact: "project.trusted", equals: true },
                    decisions: [],
                    activateProfiles: [],
                },
            ],
        };

        const configuration = createPolicyConfiguration({
            resolved,
            globalDocument,
            session: { overrides: [] },
        });

        expect(configuration.global.overrides).toEqual([]);
        expect(configuration.global.profiles.unsafe?.decisions).toEqual([]);
        expect(configuration.global.rules).toHaveLength(1);
        expect(configuration.diagnostics).toEqual(
            expect.arrayContaining([
                expect.stringContaining("must select a name plus source or path"),
                expect.stringContaining("invalid for command"),
                expect.stringContaining("Duplicate global rule ID duplicate"),
            ]),
        );
    });
});
