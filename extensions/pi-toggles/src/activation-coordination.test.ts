import { describe, expect, it } from "vitest";
import {
    parseActivationProposalOwner,
    parseActivationReady,
    parseExtensionActivationProposal,
} from "./activation-coordination.ts";

describe("activation coordination event parsing", () => {
    it("parses versioned ready and proposal payloads", () => {
        expect(parseActivationReady({ version: 1, sessionId: "session-1" })).toEqual({
            status: "ok",
            value: { version: 1, sessionId: "session-1" },
        });
        expect(
            parseExtensionActivationProposal({
                version: 1,
                sessionId: "session-1",
                owner: "@example/tool-extension",
                decisions: [
                    { target: { kind: "tool", name: "edit" }, state: "off" },
                    {
                        target: { kind: "tool", name: "apply_patch", source: "example" },
                        state: "on",
                    },
                ],
            }),
        ).toMatchObject({ status: "ok" });
    });

    it.each([
        { version: 2, sessionId: "session-1" },
        { version: 1, sessionId: "session-1", extra: true },
        {
            version: 1,
            sessionId: "session-1",
            owner: "bad owner",
            decisions: [],
        },
        {
            version: 1,
            sessionId: "session-1",
            owner: "extension-a",
            decisions: [{ target: { kind: "tool", name: "edit" }, state: "name-only" }],
        },
    ])("rejects malformed coordination payload %#", (payload) => {
        expect(parseExtensionActivationProposal(payload).status).toBe("invalid");
    });

    it("rejects unknown fields in proposal owner payloads", () => {
        expect(
            parseActivationProposalOwner({
                version: 1,
                sessionId: "session-1",
                owner: "extension-a",
                decisions: [],
            }).status,
        ).toBe("invalid");
    });
});
