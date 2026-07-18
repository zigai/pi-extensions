import { describe, expect, it } from "vitest";
import {
    createCapabilityId,
    isDesiredStateAllowed,
    selectorForCapability,
    selectorMatches,
    type Capability,
} from "./capability.ts";

const readCapability: Capability = {
    id: "tool|builtin|<builtin:read>|read",
    kind: "tool",
    name: "read",
    description: "Read files",
    source: {
        source: "builtin",
        scope: "temporary",
        origin: "top-level",
        path: "<builtin:read>",
    },
    observedState: "active",
    supported: true,
    protected: false,
};

describe("capability identity and selectors", () => {
    it("escapes identity delimiters deterministically", () => {
        expect(createCapabilityId("tool", "a|b", { source: "x%y", path: "p" })).toBe(
            "tool|x%25y|p|a%7Cb",
        );
    });

    it("creates an exact selector from a catalog capability", () => {
        const selector = selectorForCapability(readCapability);
        expect(selectorMatches(selector, readCapability)).toBe(true);
        expect(selector).toEqual({
            kind: "tool",
            name: "read",
            source: "builtin",
            path: "<builtin:read>",
        });
    });

    it("rejects states not supported by a capability kind", () => {
        expect(isDesiredStateAllowed("tool", "lazy")).toBe(true);
        expect(isDesiredStateAllowed("command", "lazy")).toBe(false);
        expect(isDesiredStateAllowed("skill", "user-only")).toBe(true);
    });
});
