import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
    loadTypedCommandPresets,
    recordTypedCommandRecentValues,
    saveTypedCommandPreset,
} from "../src/pi/presets.js";
import type { RegisteredTypedCommand } from "../src/pi/command-types.js";

const command: RegisteredTypedCommand = {
    name: "preset-test",
    description: "Preset test",
    args: {
        path: { type: "string", required: true },
        token: { type: "string", sensitive: true },
        tags: { type: "string-list" },
    },
    formSymbols: {
        selectedCheckbox: "■",
        unselectedCheckbox: "□",
        selectedRadio: "●",
        unselectedRadio: "○",
    },
};

describe("typed command presets", () => {
    it("persists project-scoped recent and named values without secrets", () => {
        const cwd = mkdtempSync(join(tmpdir(), "pi-typed-presets-"));
        const context = { cwd, isProjectTrusted: () => true };
        const values = { path: "demo", token: "private", tags: ["api", "worker"] };

        assert.equal(recordTypedCommandRecentValues(context, command, values), true);
        assert.equal(saveTypedCommandPreset(context, command, "default", values), true);

        const loaded = loadTypedCommandPresets(context, command);
        assert.deepEqual(loaded?.recent, { path: "demo", tags: ["api", "worker"] });
        assert.deepEqual(loaded?.presets.default, {
            path: "demo",
            tags: ["api", "worker"],
        });
        const stored = readFileSync(
            join(cwd, CONFIG_DIR_NAME, "pi-typed-args", "presets.json"),
            "utf8",
        );
        assert.doesNotMatch(stored, /private/);
    });

    it("does not overwrite malformed preset data", () => {
        const cwd = mkdtempSync(join(tmpdir(), "pi-typed-presets-malformed-"));
        const path = join(cwd, CONFIG_DIR_NAME, "pi-typed-args", "presets.json");
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "{malformed");
        const context = { cwd, isProjectTrusted: () => true };

        assert.equal(saveTypedCommandPreset(context, command, "default", { path: "demo" }), false);
        assert.equal(readFileSync(path, "utf8"), "{malformed");
    });
});
