import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearToolRows, observeToolRow, refreshToolRows } from "../../src/pi/session.ts";
import { VirtualTerminal } from "../support/virtual-terminal.ts";

class ObservedToolExecutionComponent extends ToolExecutionComponent {
    invalidations = 0;

    override invalidate(): void {
        this.invalidations += 1;
        super.invalidate();
    }
}

describe("tool row refresh", () => {
    let terminal: VirtualTerminal;
    let tui: TuiMainScreen;

    beforeEach(() => {
        clearToolRows();
        initTheme("dark");
        terminal = new VirtualTerminal(100, 30);
        tui = new TuiMainScreen(terminal);
    });

    afterEach(() => {
        clearToolRows();
        tui.stop();
        terminal.dispose();
    });

    function row(id: string): ObservedToolExecutionComponent {
        const component = new ObservedToolExecutionComponent(
            "bash",
            id,
            { command: "printf sample" },
            undefined,
            undefined,
            tui,
            "/fixture",
        );
        observeToolRow(component);
        return component;
    }

    it("refreshes only the changed tool call, including multiple views of that call", () => {
        const changed = row("changed");
        const secondView = row("changed");
        const unrelated = row("unrelated");

        refreshToolRows({ mode: "tui" }, "changed");

        expect(changed.invalidations).toBe(1);
        expect(secondView.invalidations).toBe(1);
        expect(unrelated.invalidations).toBe(0);
    });

    it("leaves all rows unchanged when the tool call is no longer displayed", () => {
        const displayed = row("displayed");

        refreshToolRows({ mode: "tui" }, "missing");

        expect(displayed.invalidations).toBe(0);
    });

    it("still refreshes the whole transcript for a session-wide change", () => {
        const first = row("first");
        const second = row("second");

        refreshToolRows({ mode: "tui" });

        expect(first.invalidations).toBe(1);
        expect(second.invalidations).toBe(1);
    });
});
