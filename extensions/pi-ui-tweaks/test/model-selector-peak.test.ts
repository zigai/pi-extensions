import { Text } from "@earendil-works/pi-tui";
import { PHYSICAL_MODEL_ID } from "@zigai/pi-extension-internals";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installModelSelectorPeakPatch } from "../src/model-selector-peak.ts";

class Selector {
    filteredModels = [
        {
            id: "display",
            provider: "display-provider",
            model: {
                id: "mimo-v2.6-pro",
                provider: "provider",
                [PHYSICAL_MODEL_ID]: "mimo-v2.6-pro",
            },
        },
    ];

    selectedIndex = 0;
    closed = false;

    listContainer = {
        children: new Array<Text>(),
        addChild(child: Text) {
            this.children.push(child);
        },
    };

    tui = {
        requestRender: () => {
            this.renders += 1;
        },
    };

    renders = 0;

    updateList() {
        this.listContainer.children = [new Text("  display [display-provider]", 0, 0)];
    }

    dispose() {
        this.closed = true;
    }
}

const config = {
    offPeakRules: [{ provider: "provider", model: "mimo-v2.6-pro", schedule: "mimo" as const }],
    deepseekHolidayCalendar: [],
};

function text(selector: Selector): string {
    return selector.listContainer.children
        .flatMap((child) => child.render(100))
        .join("")
        .trimEnd();
}
afterEach(() => vi.useRealTimers());
describe("model picker off-peak indicator", () => {
    it("requires exact physical provider and model and updates the open picker at the next minute", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-05T15:58:30Z"));
        const handle = installModelSelectorPeakPatch(
            config,
            () => ({ fg: (_color, value) => value }),
            Selector.prototype,
        );
        const selector = new Selector();
        selector.updateList();
        expect(text(selector)).toBe("  display [display-provider]  peak · off-peak starts in 2m");
        vi.advanceTimersByTime(30_000);
        expect(text(selector)).toBe("  display [display-provider]  peak · off-peak starts in 1m");
        expect(selector.renders).toBe(1);
        selector.filteredModels[0].model.id = "alias";
        selector.updateList();
        expect(text(selector)).toBe("  display [display-provider]  peak · off-peak starts in 1m");
        selector.filteredModels[0].model[PHYSICAL_MODEL_ID] = "different";
        selector.updateList();
        expect(text(selector)).toBe("  display [display-provider]");
        selector.filteredModels[0].model[PHYSICAL_MODEL_ID] = "mimo-v2.6-pro";
        selector.filteredModels[0].model.provider = "other";
        selector.updateList();
        expect(text(selector)).toBe("  display [display-provider]");
        selector.dispose();
        vi.advanceTimersByTime(120_000);
        expect(selector.renders).toBe(1);
        handle.dispose();
    });

    it("colors off-peak and peak distinctly and omits the label when the row is too narrow", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-05T16:00:00Z"));
        const handle = installModelSelectorPeakPatch(
            config,
            () => ({ fg: (color, value) => `<${color}>${value}</${color}>` }),
            Selector.prototype,
        );
        const selector = new Selector();
        selector.updateList();
        expect(text(selector)).toBe(
            "  display [display-provider]  <success>off-peak · ends in 8h</success>",
        );
        expect(selector.listContainer.children[0].render(35).join("").trimEnd()).toBe(
            "  display [display-provider]",
        );
        vi.setSystemTime(new Date("2026-01-05T15:58:30Z"));
        selector.updateList();
        expect(text(selector)).toBe(
            "  display [display-provider]  <muted>peak · off-peak starts in 2m</muted>",
        );
        selector.dispose();
        handle.dispose();
    });

    it("stops open picker timers when the extension is disposed", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-05T15:58:30Z"));
        const handle = installModelSelectorPeakPatch(
            config,
            () => ({ fg: (_color, value) => value }),
            Selector.prototype,
        );
        const selector = new Selector();
        selector.updateList();
        expect(text(selector)).toBe("  display [display-provider]  peak · off-peak starts in 2m");
        handle.dispose();
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(120_000);
        expect(selector.renders).toBe(0);
    });

    it("suppresses ambiguous duplicate mappings and unverified holidays", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-05T01:00:00Z"));
        const handle = installModelSelectorPeakPatch(
            { ...config, offPeakRules: [config.offPeakRules[0], config.offPeakRules[0]] },
            () => ({ fg: (_color, value) => value }),
            Selector.prototype,
        );
        const selector = new Selector();
        selector.updateList();
        expect(text(selector)).toBe("  display [display-provider]");
        selector.filteredModels[0].model[PHYSICAL_MODEL_ID] = "deepseek-flash";
        handle.update({
            ...config,
            offPeakRules: [
                { provider: "provider", model: "deepseek-flash", schedule: "deepseek-direct" },
            ],
        });

        selector.updateList();
        expect(text(selector)).toBe("  display [display-provider]");
        handle.update({
            offPeakRules: [
                { provider: "provider", model: "deepseek-flash", schedule: "deepseek-direct" },
            ],
            deepseekHolidayCalendar: [{ date: "2026-01-05", holiday: false }],
        });

        selector.updateList();
        expect(text(selector)).toBe("  display [display-provider]  peak · off-peak starts in 3h");
        handle.update({
            offPeakRules: [
                { provider: "provider", model: "deepseek-flash", schedule: "deepseek-direct" },
            ],
            deepseekHolidayCalendar: [
                { date: "2026-01-05", holiday: false },
                { date: "2026-01-05", holiday: true },
            ],
        });

        selector.updateList();
        expect(text(selector)).toBe("  display [display-provider]");
        selector.dispose();
        handle.dispose();
    });
});
