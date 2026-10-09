import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { TogglesPanel, type PanelItem, type TogglesPanelStyles } from "./toggles-panel.ts";

const styles: TogglesPanelStyles = {
    accent: (text) => text,
    text: (text) => text,
    muted: (text) => text,
    dim: (text) => text,
    warning: (text) => text,
    success: (text) => text,
    error: (text) => text,
    selected: (text) => text,
    bold: (text) => text,
    border: (text) => text,
};

function item(category: PanelItem["category"], label: string, currentValue = "inherit"): PanelItem {
    return {
        id: `${category}:${label}`,
        category,
        label,
        currentValue,
        effectiveValue: currentValue === "inherit" ? "active" : currentValue,
        decidedBy: "Pi",
        description: `Description for ${label}`,
        values: ["inherit", "on", "off"],
    };
}

describe("TogglesPanel", () => {
    it("separates capability kinds into tabs and aligns policy values", () => {
        const panel = new TogglesPanel(
            [
                item("tool", "read"),
                item("tool", "search-capabilities"),
                item("skill", "typescript"),
            ],
            "session",
            styles,
            vi.fn(),
            vi.fn(),
        );

        const lines = panel.render(80);
        expect(lines.join("\n")).toContain("Tools 2");
        expect(lines.join("\n")).toContain("Skills 1");
        expect(lines.join("\n")).toContain("Commands 0");
        expect(lines.join("\n")).not.toContain("tool  read");
        const readLine = lines.find((line) => line.includes("read"));
        const searchLine = lines.find((line) => line.includes("search-capabilities"));
        expect(readLine?.indexOf("inherit")).toBe(searchLine?.indexOf("inherit"));
        expect(lines.join("\n")).not.toContain("SOURCE");
        expect(lines.join("\n")).not.toContain("RUNTIME");
    });

    it("switches tabs and changes the selected policy", () => {
        const onChange = vi.fn();
        const panel = new TogglesPanel(
            [item("tool", "read"), item("skill", "typescript")],
            "session",
            styles,
            onChange,
            vi.fn(),
        );

        panel.handleInput("\t");
        expect(panel.render(80).join("\n")).toContain("typescript");
        expect(panel.render(80).join("\n")).not.toContain("› read");
        panel.handleInput("\r");
        expect(onChange).toHaveBeenCalledWith("skill:typescript", "on");
    });

    it("never emits lines wider than the terminal", () => {
        const panel = new TogglesPanel(
            [item("tool", "a-capability-name-that-is-much-too-long-for-this-terminal")],
            "project",
            styles,
            vi.fn(),
            vi.fn(),
        );

        const lines = panel.render(36);
        expect(lines.every((line) => visibleWidth(line) <= 36)).toBe(true);
        expect(lines.join("\n")).toContain("ctrl+s apply");
        expect(lines.join("\n")).toContain("esc cancel");
    });

    it("promotes capability context into columns on wide terminals", () => {
        const panel = new TogglesPanel([item("tool", "read")], "global", styles, vi.fn(), vi.fn());

        const output = panel.render(120).join("\n");
        expect(output).toContain("EFFECTIVE");
        expect(output).toContain("DECIDED BY");
        expect(output).toContain("DESCRIPTION");
        expect(output).toContain("Description for read");
    });

    it("places scroll position at the top right instead of below the list", () => {
        const panel = new TogglesPanel(
            Array.from({ length: 25 }, (_value, index) => item("skill", `skill-${index + 1}`)),
            "session",
            styles,
            vi.fn(),
            vi.fn(),
        );

        let lines = panel.render(80);
        expect(lines[1]?.trimEnd()).toMatch(/\(1\/25\)$/);
        expect(lines.join("\n")).not.toContain("1 of 25");
        panel.handleInput("\x1b[B");
        lines = panel.render(80);
        expect(lines[1]?.trimEnd()).toMatch(/\(2\/25\)$/);
    });
});
