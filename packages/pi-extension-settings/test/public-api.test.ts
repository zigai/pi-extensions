import { describe, expect, it } from "vitest";

import * as settings from "../src/index.ts";
import * as piSettings from "../src/pi.ts";

describe("public API", () => {
    it("exposes only definition and Pi-facing runtime operations", () => {
        expect(Object.keys(settings).sort()).toEqual(["defineExtensionSettings"]);
        expect(Object.keys(piSettings).sort()).toEqual([
            "getPiGlobalSettingsPath",
            "getPiProjectSettingsPath",
            "loadPiExtensionSettings",
        ]);
    });
});
