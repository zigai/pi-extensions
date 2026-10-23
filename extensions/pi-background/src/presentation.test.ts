import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, it } from "vitest";
import { BackgroundView } from "./presentation.ts";
import type { CommandSnapshot } from "./commands.ts";

const theme: Pick<Theme, "fg" | "bold"> = {
    fg: (_color, value) => value,
    bold: (value) => value,
};

function job(overrides: Partial<CommandSnapshot> = {}): CommandSnapshot {
    return {
        id: "task-one",
        command: "npm test",
        cwd: "/project",
        outputPath: "/private/output/task-one.log",
        state: "running",
        exitCode: null,
        error: null,
        ...overrides,
    };
}

it("shows job commands and states without internal IDs or paths", () => {
    const view = new BackgroundView();
    view.update([
        job(),
        job({ id: "task-two", command: "npm run build", state: "completed", exitCode: 0 }),
    ]);
    const lines = view.render(80, theme).map(stripTerminalSequences);

    expect(lines.join("\n")).toContain("npm test");
    expect(lines.join("\n")).toContain("running");
    expect(lines.join("\n")).toContain("npm run build");
    expect(lines.join("\n")).toContain("done");
    expect(lines.join("\n")).not.toContain("task-one");
    expect(lines.join("\n")).not.toContain("/private");
});

it.each([1, 12, 32, 80])(
    "keeps Unicode and multiline commands inside %s terminal columns",
    (width) => {
        const view = new BackgroundView();
        view.update([
            job({
                command:
                    "printf '界界 🧪'\n\u001b]2;UNSAFE\u0007\tcontinued command with a long tail",
            }),
        ]);
        const lines = view.render(width, theme);

        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        expect(lines.join("\n")).not.toContain("\u001b]2;");
        expect(lines.join("\n")).not.toContain("\u0007");
    },
);

it("updates completed states and keeps dismissed jobs hidden after later updates", () => {
    const view = new BackgroundView();
    view.update([job()]);
    view.update([job({ state: "completed", exitCode: 7 })]);
    expect(view.render(80, theme).map(stripTerminalSequences).join("\n")).toContain("exit 7");

    view.dismiss("task-one");
    expect(view.render(80, theme)).toEqual([]);
    view.update([
        job({ state: "completed", exitCode: 7 }),
        job({ id: "task-two", command: "npm run build" }),
    ]);
    const visible = view.render(80, theme).map(stripTerminalSequences).join("\n");
    expect(visible).not.toContain("npm test");
    expect(visible).toContain("npm run build");
});
