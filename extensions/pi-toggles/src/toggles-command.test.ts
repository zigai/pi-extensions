import { describe, expect, it } from "vitest";
import type { Capability } from "./capability.ts";
import { capabilityPanelColumns, parseTogglesCommand } from "./toggles-command.ts";

const agentBrowser: Capability = {
    id: "tool|agent-browser|dist/extensions/agent-browser/index.js|agent_browser",
    kind: "tool",
    name: "agent_browser",
    description: "Browse and interact with websites using agent-browser.",
    source: {
        source: "user",
        scope: "user",
        origin: "package",
        path: "dist/extensions/agent-browser/index.js",
    },
    observedState: "active",
    supported: true,
    protected: false,
};

describe("parseTogglesCommand", () => {
    it("opens the panel for empty input", () => {
        expect(parseTogglesCommand("")).toEqual({ status: "ok", request: { action: "panel" } });
    });

    it("parses a scoped set operation", () => {
        expect(parseTogglesCommand("set write off --scope project")).toEqual({
            status: "ok",
            request: { action: "set", reference: "write", state: "off", scope: "project" },
        });
    });

    it("parses quoted capability references", () => {
        expect(parseTogglesCommand("explain 'tool|package|path|tool name'")).toEqual({
            status: "ok",
            request: { action: "explain", reference: "tool|package|path|tool name" },
        });
    });

    it("rejects invalid states and unterminated quotes", () => {
        expect(parseTogglesCommand("set write maybe").status).toBe("invalid");
        expect(parseTogglesCommand("set write off extra").status).toBe("invalid");
        expect(parseTogglesCommand("explain 'write").status).toBe("invalid");
    });

    it("provides decision-useful table columns without implementation paths", () => {
        expect(capabilityPanelColumns(agentBrowser, undefined)).toEqual({
            effectiveValue: "active",
            decidedBy: "Pi",
            description: "Browse and interact with websites using agent-browser.",
        });
    });
});
