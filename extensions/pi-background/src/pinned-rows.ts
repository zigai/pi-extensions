import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import {
    installKeyedLinkedMethodPatch,
    warnPiInternalPatchUnavailable,
} from "@zigai/pi-extension-internals";
import { Type, type StaticDecode } from "typebox";
import { Value } from "typebox/value";

const rowsMarker = Symbol.for("zigai.pi-background.input-dock-rows");
const widgetRowsMarker = Symbol.for("zigai.pi-background.idle-input-dock-rows");
const widgetKey = "pi-background-progress";

const componentSchema = Type.Object({
    render: Type.Function([Type.Number()], Type.Array(Type.String())),
    invalidate: Type.Function([], Type.Void()),
});

const containerSchema = Type.Object({
    ...componentSchema.properties,
    children: Type.Array(componentSchema),
});

const indicatorSchema = Type.Object({
    kind: Type.Literal("working"),
    getRenderedIndicator: Type.Function([], Type.String()),
});

type InputDock = {
    readonly status: StaticDecode<typeof componentSchema>;
    readonly widgetsAbove: StaticDecode<typeof componentSchema>;
    readonly workingPrefix: () => string;
};

type Rows = (width: number) => string[];
export type PinnedRows = { refresh(): void; dispose(): void };

export function pinRows(dock: InputDock, rows: Rows, requestRender: () => void): PinnedRows {
    const policy = { rows, prefix: dock.workingPrefix };
    const statusPatch = installKeyedLinkedMethodPatch(
        dock.status,
        "render",
        rowsMarker,
        policy,
        (predecessor, currentPolicy) =>
            function (width) {
                const original = predecessor.call(this, width);
                if (original.length === 0) return original;

                const current = currentPolicy();
                const added = current.rows(width);
                if (added.length === 0) return original;

                const prefix = current.prefix();
                let position = 0;
                if (original[0] === "") position += 1;
                if (prefix.length > 0) position += new Text(prefix, 1, 0).render(width).length;

                return [...original.slice(0, position), ...added, ...original.slice(position)];
            },
    );

    try {
        const widgetPatch = installKeyedLinkedMethodPatch(
            dock.widgetsAbove,
            "render",
            widgetRowsMarker,
            rows,
            (predecessor, getRows) =>
                function (width) {
                    const original = predecessor.call(this, width);
                    if (statusPatch.predecessor.call(dock.status, width).length > 0)
                        return original;

                    return [...original, ...getRows()(width)];
                },
        );
        let disposed = false;

        return {
            refresh() {
                if (!disposed) requestRender();
            },
            dispose() {
                if (disposed) return;

                disposed = true;
                widgetPatch.dispose();
                statusPatch.dispose();
                requestRender();
            },
        };
    } catch (cause) {
        statusPatch.dispose();
        throw cause;
    }
}

function workingPrefix(status: StaticDecode<typeof componentSchema>): string {
    if (!Value.Check(containerSchema, status)) return "";

    for (const child of status.children) {
        if (!Value.Check(indicatorSchema, child)) continue;

        const frame = child.getRenderedIndicator();
        const separator = frame.lastIndexOf("\n");
        if (separator >= 0) return frame.slice(0, separator);
    }

    return "";
}

function findInputDock(root: Component, marker: Component): InputDock | undefined {
    if (!Value.Check(containerSchema, root)) return undefined;

    for (let index = root.children.length - 1; index >= 0; index -= 1) {
        const child = root.children[index];
        if (!Value.Check(containerSchema, child) || !child.children.includes(marker)) continue;
        if (index === 0) return undefined;

        const status = root.children[index - 1];
        if (!Value.Check(componentSchema, status)) return undefined;

        return { status, widgetsAbove: child, workingPrefix: () => workingPrefix(status) };
    }

    for (let index = root.children.length - 1; index >= 0; index -= 1) {
        const found = findInputDock(root.children[index], marker);
        if (found !== undefined) return found;
    }

    return undefined;
}

export function mountPinnedRows(
    ui: ExtensionUIContext,
    rows: (width: number, theme: Theme) => string[],
): PinnedRows | undefined {
    const marker = new Container();
    let root: Component | undefined;

    try {
        ui.setWidget(widgetKey, (tui) => {
            root = tui;
            return marker;
        });

        let dock: InputDock | undefined;
        if (root !== undefined) dock = findInputDock(root, marker);

        if (dock === undefined) {
            warnPiInternalPatchUnavailable("pi-background", "pinned command rows");
            return undefined;
        }

        return pinRows(
            dock,
            (width) => rows(width, ui.theme),
            () => ui.setWidget(widgetKey, undefined),
        );
    } catch (cause) {
        warnPiInternalPatchUnavailable("pi-background", "pinned command rows", cause);
        return undefined;
    } finally {
        ui.setWidget(widgetKey, undefined);
    }
}
