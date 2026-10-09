import { expect, test } from "vitest";
import { AliasPolicy } from "../src/alias-policy.ts";
import type { LoadedModelAliasSettings } from "../src/settings.ts";

test("registry refresh and settings identity invalidate collisions without selector cache interference", () => {
    let loaded: LoadedModelAliasSettings = {
        path: "/settings.json",
        mtimeMs: 1,
        settings: {
            aliases: [{ provider: "openai", model: "native", alias: "fast" }],
            providerAliases: [{ provider: "openai", name: "Work" }],
            stableProviderColumn: true,
        },
    };
    const policy = new AliasPolicy({ loadSettings: () => loaded });
    const native = [{ provider: "openai", id: "native" }];
    const collision = [...native, { provider: "openai", id: "fast" }];
    expect(policy.load(() => native)).toBe(loaded);
    expect(policy.forModels(collision).aliases).toEqual([]);
    expect(policy.load(() => collision)).toBe(loaded);
    const rejected = policy.load(() => collision, true);
    expect(rejected.settings.aliases).toEqual([]);
    expect(rejected.settings.providerAliases).toEqual([]);
    expect(rejected.diagnostic).toContain("conflicts with an existing model id");
    expect(policy.load(() => native)).toBe(rejected);
    expect(policy.forModels(native)).toBe(loaded.settings);
    expect(policy.load(() => native)).toBe(rejected);
    loaded = { ...loaded, mtimeMs: 2 };
    expect(policy.load(() => native)).toBe(loaded);
    expect(policy.load(() => collision, true).diagnostic).toBeDefined();
    expect(policy.load(() => native, true)).toBe(loaded);
});
