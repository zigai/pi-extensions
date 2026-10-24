import { expect, it } from "vitest";
import { commandLabel, commandStatus, plainOutput, runningShellStatus } from "./presentation.ts";
import type { CommandSnapshot } from "./commands.ts";

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

it("hides the indicator when there are no running shells", () => {
    expect(runningShellStatus([])).toBe("");
    expect(
        runningShellStatus([
            job({ state: "completed", exitCode: 0 }),
            job({ state: "completed", exitCode: 7 }),
            job({ state: "failed" }),
            job({ state: "stopped" }),
        ]),
    ).toBe("");
});

it("counts only running shells with singular and plural wording", () => {
    expect(runningShellStatus([job()])).toBe("1 shell running");
    expect(runningShellStatus([job(), job({ state: "completed", exitCode: 0 })])).toBe(
        "1 shell running",
    );

    expect(runningShellStatus([job(), job({ id: "task-two" })])).toBe("2 shells running");
});

it("keeps terminal controls and multiline commands out of labels", () => {
    expect(commandLabel("printf '界界 🧪'\n\u001b]2;UNSAFE\u0007\tcontinued")).toBe(
        "printf '界界 🧪' continued",
    );

    expect(plainOutput("first\n\tsecond\r\u0000")).toBe("first\n\tsecond  ");
});

it.each([
    [job(), "running"],
    [job({ state: "stopped" }), "stopped"],
    [job({ state: "failed" }), "failed"],
    [job({ state: "completed", exitCode: 0 }), "done"],
    [job({ state: "completed", exitCode: 7 }), "exit 7"],
])("keeps detailed statuses available for the job picker", (snapshot, text) => {
    expect(commandStatus(snapshot).text).toBe(text);
});
