import { Container, Text } from "@earendil-works/pi-tui";
import { installLinkedRenderPatch } from "@zigai/pi-extension-internals";
import { expect, it } from "vitest";
import { pinRows } from "./pinned-rows.ts";

function rendered(status: Container): string[] {
    return status.render(80).map((line) => line.trimEnd());
}

it("keeps background, subagent, and working rows independent through updates and cleanup", () => {
    const status = new Container();
    status.addChild(new Text("Research agent\nWorking", 0, 0));
    let jobs = ["npm test · running"];
    let prefix = "Research agent";
    const pinned = pinRows(
        { status, widgetsAbove: new Container(), workingPrefix: () => prefix },
        () => jobs,
        () => {},
    );

    expect(rendered(status)).toEqual(["Research agent", "npm test · running", "Working"]);
    jobs = ["npm test · done", "npm run build · running"];
    pinned.refresh();
    expect(rendered(status)).toEqual([
        "Research agent",
        "npm test · done",
        "npm run build · running",
        "Working",
    ]);

    status.clear();
    prefix = "";
    status.addChild(new Text("Working", 0, 0));
    expect(rendered(status)).toEqual(["npm test · done", "npm run build · running", "Working"]);
    pinned.dispose();
    pinned.dispose();
    expect(rendered(status)).toEqual(["Working"]);
});

it("preserves later rendering layers when the background panel is disposed first", () => {
    const status = new Container();
    status.addChild(new Text("Working", 0, 0));
    const pinned = pinRows(
        { status, widgetsAbove: new Container(), workingPrefix: () => "" },
        () => ["npm test · running"],
        () => {},
    );
    const other = installLinkedRenderPatch(
        status,
        (predecessor) =>
            function (width) {
                return [...predecessor.call(this, width), "Other extension"];
            },
    );

    pinned.dispose();
    expect(rendered(status)).toEqual(["Working", "Other extension"]);
    other.dispose();
    expect(rendered(status)).toEqual(["Working"]);
});

it("stays visible when Pi embeds its working indicator in the editor instead", () => {
    const status = new Container();
    const widgets = new Container();
    widgets.addChild(new Text("Research agent", 0, 0));
    let jobs = ["npm test · running"];
    const pinned = pinRows(
        { status, widgetsAbove: widgets, workingPrefix: () => "" },
        () => jobs,
        () => {},
    );

    expect(status.render(80)).toEqual([]);
    expect(rendered(widgets)).toEqual(["Research agent", "npm test · running"]);
    jobs = [];
    expect(rendered(widgets)).toEqual(["Research agent"]);
    pinned.dispose();
    expect(rendered(widgets)).toEqual(["Research agent"]);
});
