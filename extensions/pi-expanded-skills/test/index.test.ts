import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import extension, { extensionName, packageName } from "../src/index.ts";

describe("extension entrypoint", () => {
    it("exports generated package metadata", () => {
        expect(packageName).toBe("pi-expanded-skills");
        expect(extensionName).toBe("Pi Expanded Skills");
        expect(typeof extension).toBe("function");
    });

    it("registers without required startup work", () => {
        // SAFETY: The generated starter extension does not read from the Pi API.
        const pi = {} as ExtensionAPI;

        expect(extension(pi)).toBeUndefined();
    });
});
