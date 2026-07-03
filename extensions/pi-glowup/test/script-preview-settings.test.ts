import { describe, expect, it } from "vitest";
import { parseScriptPreviewHeaderLayout } from "../src/script-preview-settings.ts";

describe("script preview settings", () => {
  it("defaults script preview headers to auto layout", () => {
    expect(parseScriptPreviewHeaderLayout(undefined)).toBe("auto");
    expect(parseScriptPreviewHeaderLayout("")).toBe("auto");
    expect(parseScriptPreviewHeaderLayout("unknown")).toBe("auto");
  });

  it("enables explicit script preview header layouts", () => {
    expect(parseScriptPreviewHeaderLayout("auto")).toBe("auto");
    expect(parseScriptPreviewHeaderLayout(" AUTO ")).toBe("auto");
    expect(parseScriptPreviewHeaderLayout("inline")).toBe("inline");
    expect(parseScriptPreviewHeaderLayout(" INLINE ")).toBe("inline");
    expect(parseScriptPreviewHeaderLayout("block")).toBe("block");
    expect(parseScriptPreviewHeaderLayout(" BLOCK ")).toBe("block");
  });
});
