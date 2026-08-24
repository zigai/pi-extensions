import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getPiAgentDir } from "../src/pi-host-paths.ts";

const HOME_DIRECTORY = join("", "home", "settings-user");

describe("Pi host paths", () => {
    it("uses the standard agent directory when no override is configured", () => {
        expect(getPiAgentDir({}, HOME_DIRECTORY)).toBe(join(HOME_DIRECTORY, ".pi", "agent"));
        expect(getPiAgentDir({ PI_CODING_AGENT_DIR: "" }, HOME_DIRECTORY)).toBe(
            join(HOME_DIRECTORY, ".pi", "agent"),
        );
    });

    it("preserves an explicit agent directory", () => {
        const agentDirectory = join("", "var", "lib", "pi-agent");

        expect(getPiAgentDir({ PI_CODING_AGENT_DIR: agentDirectory }, HOME_DIRECTORY)).toBe(
            agentDirectory,
        );
    });

    it("expands home-relative agent directories", () => {
        expect(getPiAgentDir({ PI_CODING_AGENT_DIR: "~" }, HOME_DIRECTORY)).toBe(HOME_DIRECTORY);
        expect(getPiAgentDir({ PI_CODING_AGENT_DIR: "~/.config/pi" }, HOME_DIRECTORY)).toBe(
            join(HOME_DIRECTORY, ".config", "pi"),
        );
    });
});
