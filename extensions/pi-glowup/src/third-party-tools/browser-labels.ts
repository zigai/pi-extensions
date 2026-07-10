import type { ToolLifecycleLabels } from "../rendering/status-labels.ts";

const BROWSER_LIFECYCLE_LABELS = new Map<string, ToolLifecycleLabels>([
    ["Browser", { static: "Browser", active: "Using Browser", completed: "Used Browser" }],
    [
        "Browser Open",
        { static: "Browser Open", active: "Opening Browser", completed: "Opened Browser" },
    ],
    [
        "Browser Snapshot",
        {
            static: "Browser Snapshot",
            active: "Taking Browser Snapshot",
            completed: "Took Browser Snapshot",
        },
    ],
    [
        "Browser Screenshot",
        {
            static: "Browser Screenshot",
            active: "Taking Browser Screenshot",
            completed: "Took Browser Screenshot",
        },
    ],
    [
        "Browser Click",
        { static: "Browser Click", active: "Clicking Browser", completed: "Clicked Browser" },
    ],
    [
        "Browser Fill",
        { static: "Browser Fill", active: "Filling Browser", completed: "Filled Browser" },
    ],
    [
        "Browser Type",
        { static: "Browser Type", active: "Typing in Browser", completed: "Typed in Browser" },
    ],
    [
        "Browser Select",
        {
            static: "Browser Select",
            active: "Selecting in Browser",
            completed: "Selected in Browser",
        },
    ],
    [
        "Browser Wait",
        { static: "Browser Wait", active: "Waiting for Browser", completed: "Waited for Browser" },
    ],
    [
        "Browser QA",
        { static: "Browser QA", active: "Checking Browser", completed: "Checked Browser" },
    ],
    [
        "Browser Source Lookup",
        {
            static: "Browser Source Lookup",
            active: "Looking Up Browser Source",
            completed: "Looked Up Browser Source",
        },
    ],
    [
        "Browser Network Lookup",
        {
            static: "Browser Network Lookup",
            active: "Looking Up Browser Network",
            completed: "Looked Up Browser Network",
        },
    ],
    [
        "Browser Evaluate",
        {
            static: "Browser Evaluate",
            active: "Evaluating in Browser",
            completed: "Evaluated in Browser",
        },
    ],
    [
        "Browser Hover",
        { static: "Browser Hover", active: "Hovering in Browser", completed: "Hovered in Browser" },
    ],
    [
        "Browser Navigate",
        {
            static: "Browser Navigate",
            active: "Navigating Browser",
            completed: "Navigated Browser",
        },
    ],
    [
        "Browser Pages",
        {
            static: "Browser Pages",
            active: "Listing Browser Pages",
            completed: "Listed Browser Pages",
        },
    ],
    [
        "Browser Select Page",
        {
            static: "Browser Select Page",
            active: "Selecting Browser Page",
            completed: "Selected Browser Page",
        },
    ],
    [
        "Browser Close Page",
        {
            static: "Browser Close Page",
            active: "Closing Browser Page",
            completed: "Closed Browser Page",
        },
    ],
    [
        "Browser Resize",
        {
            static: "Browser Resize",
            active: "Resizing Browser",
            completed: "Resized Browser",
        },
    ],
    [
        "Browser Performance",
        {
            static: "Browser Performance",
            active: "Analyzing Browser Performance",
            completed: "Analyzed Browser Performance",
        },
    ],
    ["Electron", { static: "Electron", active: "Using Electron", completed: "Used Electron" }],
]);

export function browserLifecycleLabels(staticLabel: string): ToolLifecycleLabels {
    return (
        BROWSER_LIFECYCLE_LABELS.get(staticLabel) ?? {
            static: staticLabel,
            active: `Using ${staticLabel}`,
            completed: `Used ${staticLabel}`,
        }
    );
}
