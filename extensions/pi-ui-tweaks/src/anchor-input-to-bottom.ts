import { TuiAltScreen, TuiMainScreen, type Component } from "@earendil-works/pi-tui";

import {
    installLinkedMethodPatch,
    installLinkedRenderPatch,
    type LinkedMethodPatchHandle,
} from "@zigai/pi-extension-internals";

const ANCHOR_INPUT_TO_BOTTOM_PATCHED = Symbol.for(
    "zigai.pi-ui-tweaks.anchor-input-to-bottom-patch",
);
const FULLSCREEN_ANCHOR_INPUT_TO_BOTTOM_PATCHED = Symbol.for(
    "zigai.pi-ui-tweaks.fullscreen-anchor-input-to-bottom-patch",
);
const CHILD_LINE_RANGES_FRAME_KEY = Symbol.for("zigai.pi-tweaks.tui-child-line-ranges-frame");
const BOTTOM_CHROME_PRECEDING_SIBLINGS = 2;

export type AnchorInputToBottomConfig = { readonly anchorInputToBottom: boolean };

let currentAnchorConfig: AnchorInputToBottomConfig = { anchorInputToBottom: false };

type ComponentContainer = Component & {
    children: Component[];
};

type PatchableTuiInstance = {
    [CHILD_LINE_RANGES_FRAME_KEY]?: ChildLineRangesFrame;
    children: Component[];
    focusedComponent?: Component | null;

    terminal?: {
        rows?: number;
    };
};

type PatchableTuiRender = (this: PatchableTuiInstance, width: number) => string[];

type ChildLineRange = {
    index: number;
    start: number;
    end: number;
};

type ChildLineRangesFrame = {
    width: number;
    depth: number;
    recording: boolean;
    ranges?: ChildLineRange[];
};

type BottomChromeSpacing = {
    lines: string[];
    bottomChromeStartLine: number;
    removedLineIndex?: number;
};

type PatchableTuiPrototype = {
    render?: PatchableTuiRender;
    [ANCHOR_INPUT_TO_BOTTOM_PATCHED]?: AnchorPatchRecord;
};

type PatchableFullscreenTuiInstance = {
    focusedComponent?: Component | null;
    layoutRoot?: Component;
};

type PatchableFullscreenDoRender = (this: PatchableFullscreenTuiInstance) => void;

type PatchableFullscreenTuiPrototype = {
    doRender?: PatchableFullscreenDoRender;
    [FULLSCREEN_ANCHOR_INPUT_TO_BOTTOM_PATCHED]?: FullscreenAnchorPatchRecord;
};

function isPatchableFullscreenTuiPrototype(
    value: unknown,
): value is PatchableFullscreenTuiPrototype & { doRender: PatchableFullscreenDoRender } {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;

    // SAFETY: PatchableFullscreenTuiPrototype exposes only the method validated below.
    const view = value as PatchableFullscreenTuiPrototype;
    return typeof view.doRender === "function";
}

function warnAnchorInputToBottomPatchUnavailable(reason?: string): void {
    let suffix = "";
    if (reason !== undefined) {
        suffix = `: ${reason}`;
    }

    console.warn(
        `[pi-ui-tweaks] anchor input to bottom patch unavailable; Pi internals may have changed${suffix}`,
    );
}

interface CompactableComponent extends Component {
    render: (this: Component, width: number) => string[];
}

function isComponentContainer(component: Component): component is ComponentContainer {
    return "children" in component && Array.isArray(component.children);
}

function containsComponent(root: Component, target: Component): boolean {
    if (root === target) return true;
    if (!isComponentContainer(root)) return false;

    return root.children.some((child) => containsComponent(child, target));
}

function getFocusedTopLevelChildIndex(tui: PatchableTuiInstance): number | undefined {
    const focusedComponent = tui.focusedComponent;
    if (focusedComponent === undefined || focusedComponent === null) return undefined;

    for (let index = 0; index < tui.children.length; index += 1) {
        const child = tui.children.at(index);
        if (child !== undefined && containsComponent(child, focusedComponent)) return index;
    }

    return undefined;
}

function getBottomChromeStartChildIndex(tui: PatchableTuiInstance): number | undefined {
    const focusedIndex = getFocusedTopLevelChildIndex(tui);
    if (focusedIndex === undefined) return undefined;

    if (focusedIndex >= BOTTOM_CHROME_PRECEDING_SIBLINGS) {
        return focusedIndex - BOTTOM_CHROME_PRECEDING_SIBLINGS;
    }

    return focusedIndex;
}

function enterChildLineRangesFrame(tui: PatchableTuiInstance, width: number): () => void {
    const existingFrame = tui[CHILD_LINE_RANGES_FRAME_KEY];
    if (existingFrame?.width === width) {
        existingFrame.depth += 1;

        return () => {
            existingFrame.depth -= 1;
            if (existingFrame.depth === 0 && tui[CHILD_LINE_RANGES_FRAME_KEY] === existingFrame) {
                tui[CHILD_LINE_RANGES_FRAME_KEY] = undefined;
            }
        };
    }

    const frame: ChildLineRangesFrame = { width, depth: 1, recording: false };
    tui[CHILD_LINE_RANGES_FRAME_KEY] = frame;

    return () => {
        frame.depth -= 1;
        if (frame.depth === 0 && tui[CHILD_LINE_RANGES_FRAME_KEY] === frame) {
            tui[CHILD_LINE_RANGES_FRAME_KEY] = undefined;
        }
    };
}

function renderWithChildLineRanges(
    tui: PatchableTuiInstance,
    width: number,
    render: PatchableTuiRender,
): string[] {
    const frame = tui[CHILD_LINE_RANGES_FRAME_KEY];
    if (frame?.width !== width || frame.recording) {
        return render.call(tui, width);
    }

    const originals: Array<{
        child: Component;
        ownDescriptor: PropertyDescriptor | undefined;
    }> = [];
    const ranges: ChildLineRange[] = [];
    let start = 0;

    frame.recording = true;
    frame.ranges = ranges;

    try {
        for (let index = 0; index < tui.children.length; index += 1) {
            const child = tui.children.at(index);
            if (child === undefined) continue;

            const originalRender = child.render.bind(child);
            const ownDescriptor = Object.getOwnPropertyDescriptor(child, "render");
            originals.push({ child, ownDescriptor });
            child.render = function renderAndRecordChildLines(this: Component, childWidth: number) {
                const lines = originalRender.call(this, childWidth);
                ranges.push({ index, start, end: start + lines.length });
                start += lines.length;
                return lines;
            };
        }

        return render.call(tui, width);
    } finally {
        for (const original of originals) {
            if (original.ownDescriptor === undefined) {
                Reflect.deleteProperty(original.child, "render");
            } else {
                Object.defineProperty(original.child, "render", original.ownDescriptor);
            }
        }

        frame.recording = false;
    }
}

function getChildLineRanges(tui: PatchableTuiInstance, width: number): ChildLineRange[] {
    const frame = tui[CHILD_LINE_RANGES_FRAME_KEY];
    if (frame?.width === width && frame.ranges !== undefined) {
        return frame.ranges;
    }

    return [];
}

function getRangeForChild(
    ranges: readonly ChildLineRange[],
    childIndex: number,
): ChildLineRange | undefined {
    return ranges.find((range) => range.index === childIndex);
}

function hasVisibleLine(lines: readonly string[], start: number, end: number): boolean {
    for (let index = start; index < end; index += 1) {
        if (index < 0) continue;

        const line = lines.at(index);
        if (line !== undefined && line.trim().length > 0) return true;
    }

    return false;
}

function findComponentPath(
    root: Component,
    target: Component,
    visited = new Set<Component>(),
): Component[] | undefined {
    if (root === target) return [root];
    if (visited.has(root)) return undefined;

    visited.add(root);

    if (!isComponentContainer(root)) return undefined;

    for (const child of root.children) {
        const path = findComponentPath(child, target, visited);
        if (path !== undefined) return [root, ...path];
    }

    return undefined;
}

function isVerticalLayoutStack(component: Component): component is ComponentContainer {
    if (!isComponentContainer(component)) return false;
    return "layoutType" in component && component.layoutType === "vstack";
}

function getFullscreenBlankPrecedingComponent(
    tui: PatchableFullscreenTuiInstance,
): Component | undefined {
    const layoutRoot = tui.layoutRoot;
    const focusedComponent = tui.focusedComponent;
    if (layoutRoot === undefined || focusedComponent === undefined || focusedComponent === null) {
        return undefined;
    }

    const path = findComponentPath(layoutRoot, focusedComponent);
    if (path === undefined) return undefined;

    for (let pathIndex = path.length - 2; pathIndex >= 0; pathIndex -= 1) {
        const parent = path.at(pathIndex);
        const child = path.at(pathIndex + 1);
        if (parent === undefined || child === undefined) continue;
        if (!isVerticalLayoutStack(parent)) continue;

        const childIndex = parent.children.indexOf(child);
        if (childIndex <= BOTTOM_CHROME_PRECEDING_SIBLINGS) continue;

        const precedingComponent = parent.children.at(childIndex - 1);
        if (precedingComponent !== undefined) return precedingComponent;
    }

    return undefined;
}

function temporarilyCompactBlankComponent(
    component: CompactableComponent | undefined,
): (() => void) | undefined {
    if (component === undefined) return undefined;

    const originalRender = component.render;
    if (typeof originalRender !== "function") return undefined;

    const ownDescriptor = Object.getOwnPropertyDescriptor(component, "render");
    const compactedRender: Component["render"] = function compactedBlankComponentRender(
        this: Component,
        width: number,
    ): string[] {
        const lines = originalRender.call(this, width);
        if (lines.length === 0 || hasVisibleLine(lines, 0, lines.length)) return lines;

        return [];
    };

    if (!Reflect.set(component, "render", compactedRender)) return undefined;

    return () => {
        if (ownDescriptor === undefined) {
            Reflect.deleteProperty(component, "render");
        } else {
            Object.defineProperty(component, "render", ownDescriptor);
        }
    };
}

function compactFullscreenChromeForRender(
    tui: PatchableFullscreenTuiInstance,
): (() => void) | undefined {
    if (!currentAnchorConfig.anchorInputToBottom) return undefined;

    return temporarilyCompactBlankComponent(getFullscreenBlankPrecedingComponent(tui));
}

function compactBottomChromeSpacing(
    tui: PatchableTuiInstance,
    lines: readonly string[],
    width: number,
): BottomChromeSpacing | undefined {
    const focusedIndex = getFocusedTopLevelChildIndex(tui);
    if (focusedIndex === undefined) return undefined;

    const bottomChromeStartChildIndex = getBottomChromeStartChildIndex(tui);
    if (bottomChromeStartChildIndex === undefined) return undefined;

    const ranges = getChildLineRanges(tui, width);
    const focusedRange = getRangeForChild(ranges, focusedIndex);
    const bottomChromeStartRange = getRangeForChild(ranges, bottomChromeStartChildIndex);
    if (focusedRange === undefined || bottomChromeStartRange === undefined) return undefined;

    const gapIndex = focusedRange.start - 1;
    const gapLine = lines.at(gapIndex);
    if (gapIndex < 0 || gapLine === undefined || gapLine.trim().length > 0) {
        return { lines: [...lines], bottomChromeStartLine: bottomChromeStartRange.start };
    }

    if (!hasVisibleLine(lines, bottomChromeStartRange.start, gapIndex)) {
        return { lines: [...lines], bottomChromeStartLine: bottomChromeStartRange.start };
    }

    return {
        lines: [...lines.slice(0, gapIndex), ...lines.slice(gapIndex + 1)],
        bottomChromeStartLine: bottomChromeStartRange.start,
        removedLineIndex: gapIndex,
    };
}

function updateChildLineRangesAfterLayout(
    tui: PatchableTuiInstance,
    removedLineIndex: number | undefined,
    insertedLineIndex: number,
    insertedLineCount: number,
): void {
    const ranges = tui[CHILD_LINE_RANGES_FRAME_KEY]?.ranges;
    if (ranges === undefined) return;

    if (removedLineIndex !== undefined) {
        for (const range of ranges) {
            if (range.end <= removedLineIndex) continue;

            if (range.start > removedLineIndex) {
                range.start -= 1;
            }
            range.end -= 1;
        }
    }

    if (insertedLineCount <= 0) return;

    for (const range of ranges) {
        if (range.start < insertedLineIndex) continue;
        range.start += insertedLineCount;
        range.end += insertedLineCount;
    }
}

function appendBlankRows(result: string[], count: number): void {
    for (let index = 0; index < count; index += 1) {
        result.push("");
    }
}

function getTerminalRows(tui: PatchableTuiInstance): number | undefined {
    const rows = tui.terminal?.rows;
    if (rows === undefined || !Number.isFinite(rows)) return undefined;

    const roundedRows = Math.floor(rows);
    if (roundedRows <= 0) return undefined;
    return roundedRows;
}

function anchorInputToBottomLines(
    tui: PatchableTuiInstance,
    lines: readonly string[],
    width: number,
): string[] {
    if (!currentAnchorConfig.anchorInputToBottom) return [...lines];

    const compacted = compactBottomChromeSpacing(tui, lines, width);
    if (compacted === undefined) return [...lines];

    const terminalRows = getTerminalRows(tui);
    let blankRowCount = 0;
    if (terminalRows !== undefined && compacted.lines.length < terminalRows) {
        blankRowCount = terminalRows - compacted.lines.length;
    }

    updateChildLineRangesAfterLayout(
        tui,
        compacted.removedLineIndex,
        compacted.bottomChromeStartLine,
        blankRowCount,
    );

    if (blankRowCount === 0) return compacted.lines;

    const bottomChromeStartLine = Math.min(compacted.lines.length, compacted.bottomChromeStartLine);
    const result = compacted.lines.slice(0, bottomChromeStartLine);
    appendBlankRows(result, blankRowCount);
    result.push(...compacted.lines.slice(bottomChromeStartLine));

    return result;
}

export type AnchorInputToBottomHandle = {
    update(config: AnchorInputToBottomConfig): void;
    dispose(): void;
};

type AnchorPatchRecord = {
    readonly original: PatchableTuiRender;
    readonly patch: LinkedMethodPatchHandle<PatchableTuiInstance, [number], string[]>;
    readonly handle: AnchorInputToBottomHandle;
};

type FullscreenAnchorPatchRecord = {
    readonly original: PatchableFullscreenDoRender;
    readonly patch: LinkedMethodPatchHandle<PatchableFullscreenTuiInstance, [], void>;
    readonly handle: AnchorInputToBottomHandle;
};

function hasAnchorRender(
    target: PatchableTuiPrototype,
): target is PatchableTuiPrototype & { render: PatchableTuiRender } {
    return typeof target.render === "function";
}

function installMainAnchorInputToBottomPatch(
    config: AnchorInputToBottomConfig,
    target: PatchableTuiPrototype,
): AnchorInputToBottomHandle {
    if (!hasAnchorRender(target)) {
        warnAnchorInputToBottomPatchUnavailable("missing render");

        return { update(): void {}, dispose(): void {} };
    }

    const prototype = target;
    const installed = prototype[ANCHOR_INPUT_TO_BOTTOM_PATCHED];
    if (installed !== undefined) {
        installed.handle.update(config);
        return installed.handle;
    }

    currentAnchorConfig = config;

    const patch = installLinkedRenderPatch(
        prototype,
        (predecessor) =>
            function anchorInputToBottomRender(
                this: PatchableTuiInstance,
                width: number,
            ): string[] {
                const leaveFrame = enterChildLineRangesFrame(this, width);
                try {
                    const lines = renderWithChildLineRanges(this, width, predecessor);
                    return anchorInputToBottomLines(this, lines, width);
                } finally {
                    leaveFrame();
                }
            },
    );
    let disposed = false;
    const handle: AnchorInputToBottomHandle = {
        update(next): void {
            if (!disposed) currentAnchorConfig = next;
        },
        dispose(): void {
            if (disposed) return;

            disposed = true;
            patch.dispose();

            if (prototype[ANCHOR_INPUT_TO_BOTTOM_PATCHED]?.handle === handle) {
                delete prototype[ANCHOR_INPUT_TO_BOTTOM_PATCHED];
            }
        },
    };

    prototype[ANCHOR_INPUT_TO_BOTTOM_PATCHED] = { original: patch.predecessor, patch, handle };
    return handle;
}

function installFullscreenAnchorInputToBottomPatch(
    config: AnchorInputToBottomConfig,
): AnchorInputToBottomHandle {
    const target: unknown = TuiAltScreen.prototype;
    if (!isPatchableFullscreenTuiPrototype(target)) {
        warnAnchorInputToBottomPatchUnavailable("missing fullscreen doRender");

        return { update(): void {}, dispose(): void {} };
    }

    const prototype = target;
    const installed = prototype[FULLSCREEN_ANCHOR_INPUT_TO_BOTTOM_PATCHED];
    if (installed !== undefined) {
        installed.handle.update(config);
        return installed.handle;
    }

    currentAnchorConfig = config;

    const patch = installLinkedMethodPatch(
        prototype,
        "doRender",
        (predecessor) =>
            function fullscreenAnchorInputToBottomRender(
                this: PatchableFullscreenTuiInstance,
            ): void {
                const restore = compactFullscreenChromeForRender(this);
                try {
                    predecessor.call(this);
                } finally {
                    restore?.();
                }
            },
    );
    let disposed = false;
    const handle: AnchorInputToBottomHandle = {
        update(next): void {
            if (!disposed) currentAnchorConfig = next;
        },
        dispose(): void {
            if (disposed) return;

            disposed = true;
            patch.dispose();

            if (prototype[FULLSCREEN_ANCHOR_INPUT_TO_BOTTOM_PATCHED]?.handle === handle) {
                delete prototype[FULLSCREEN_ANCHOR_INPUT_TO_BOTTOM_PATCHED];
            }
        },
    };

    prototype[FULLSCREEN_ANCHOR_INPUT_TO_BOTTOM_PATCHED] = {
        original: patch.predecessor,
        patch,
        handle,
    };

    return handle;
}

/** Installs or updates the main-screen and fullscreen anchor patches. */
export function installAnchorInputToBottomPatch(
    config: AnchorInputToBottomConfig,
    prototype?: PatchableTuiPrototype,
): AnchorInputToBottomHandle {
    const main = installMainAnchorInputToBottomPatch(config, prototype ?? TuiMainScreen.prototype);
    if (prototype !== undefined) return main;

    const fullscreen = installFullscreenAnchorInputToBottomPatch(config);
    let disposed = false;

    return {
        update(next): void {
            if (disposed) return;

            main.update(next);
            fullscreen.update(next);
        },
        dispose(): void {
            if (disposed) return;

            disposed = true;
            fullscreen.dispose();
            main.dispose();
        },
    };
}
