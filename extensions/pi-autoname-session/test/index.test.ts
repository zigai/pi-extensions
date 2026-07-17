import { describe, expect, it } from "vitest";

import extension, { extensionName, packageName } from "../src/index.ts";

describe("extension entrypoint", () => {
    it("exports generated package metadata", () => {
        expect(packageName).toBe("pi-autoname-session");
        expect(extensionName).toBe("Pi Autoname Session");
        expect(typeof extension).toBe("function");
    });
});
