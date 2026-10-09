import type {
    CustomEntry,
    ExtensionContext,
    SessionEntry,
    Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";

import { getStatusBarSnapshot } from "./status-bar-api.ts";

export const WIDGET_KEY = "pi-status-bar.worked-for";
export const WORKED_FOR_STATE_ENTRY = "pi-status-bar.worked-for";
let workedForWidgetSignatures = new WeakMap<object, string>();

type StatusBarWidgetFactory = (
    tui: TUI,
    theme: Pick<Theme, "fg">,
) => Component & { dispose?(): void };

export type WorkedForState = {
    readonly durationMs: number;
    readonly tokensPerSecond?: number;
};

export type WorkedForWidgetContext = Pick<ExtensionContext, "hasUI"> & {
    ui: {
        setWidget(key: string, content: StatusBarWidgetFactory | undefined): void;
    };
};

export function resetWorkedForWidgetCache(): void {
    workedForWidgetSignatures = new WeakMap<object, string>();
}

type WorkedForEntryData = CustomEntry["data"];

function isWorkedForState(data: WorkedForEntryData): data is WorkedForState {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return false;
    }

    if (
        !("durationMs" in data) ||
        typeof data.durationMs !== "number" ||
        !Number.isFinite(data.durationMs) ||
        data.durationMs < 0
    ) {
        return false;
    }

    if (!("tokensPerSecond" in data) || data.tokensPerSecond === undefined) {
        return true;
    }

    return (
        typeof data.tokensPerSecond === "number" &&
        Number.isFinite(data.tokensPerSecond) &&
        data.tokensPerSecond > 0
    );
}

function parseWorkedForState(data: WorkedForEntryData): WorkedForState | undefined {
    if (!isWorkedForState(data)) return undefined;

    if (data.tokensPerSecond === undefined) {
        return { durationMs: data.durationMs };
    }

    return { durationMs: data.durationMs, tokensPerSecond: data.tokensPerSecond };
}

export function getWorkedForStateFromBranch(ctx: {
    readonly sessionManager: { getBranch(): readonly SessionEntry[] };
}): WorkedForState | undefined {
    let state: WorkedForState | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "custom" || entry.customType !== WORKED_FOR_STATE_ENTRY) {
            continue;
        }

        const parsed = parseWorkedForState(entry.data);
        if (parsed !== undefined) {
            state = parsed;
        }
    }

    return state;
}

export function clearWorkedForWidget(ctx: WorkedForWidgetContext): void {
    if (!ctx.hasUI) return;

    workedForWidgetSignatures.delete(ctx.ui);
    ctx.ui.setWidget(WIDGET_KEY, undefined);
}

export function formatDuration(ms: number): string {
    const wholeSeconds = Math.max(0, Math.round(ms / 1000));
    if (wholeSeconds < 60) return `${wholeSeconds}s`;

    const minutes = Math.floor(wholeSeconds / 60);
    const remainingSeconds = wholeSeconds % 60;
    if (minutes < 60) return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;

    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes.toString().padStart(2, "0")}m`;
}

export function setWorkedForWidget(
    ctx: WorkedForWidgetContext,
    workedForText?: string,
    tokensPerSecond?: number,
): void {
    if (!ctx.hasUI) return;

    const snapshot = getStatusBarSnapshot();
    if (!snapshot.idle.visible) {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        workedForWidgetSignatures.delete(ctx.ui);
        return;
    }

    let nextSignature: string | undefined;
    const idleSegments = snapshot.segments
        .filter((segment) => segment.states.includes("idle"))
        .map((segment) => segment.text)
        .join(" · ");
    if (
        snapshot.idle.text !== undefined ||
        idleSegments.length > 0 ||
        (workedForText !== undefined &&
            workedForText.length > 0 &&
            snapshot.idle.showLastRunSummary)
    ) {
        nextSignature = `${snapshot.idle.text ?? ""}\0${idleSegments}\0${workedForText ?? ""}\0${tokensPerSecond ?? ""}\0${snapshot.idle.showLastRunSummary}\0${snapshot.idle.showTokensPerSecond}`;
    }

    if (nextSignature === workedForWidgetSignatures.get(ctx.ui)) {
        return;
    }

    if (nextSignature === undefined) {
        workedForWidgetSignatures.delete(ctx.ui);
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        return;
    }

    workedForWidgetSignatures.set(ctx.ui, nextSignature);

    ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
        render(width: number): string[] {
            if (width <= 0) return [""];

            const parts: string[] = [];
            if (snapshot.idle.text !== undefined) {
                parts.push(snapshot.idle.text);
            }

            if (snapshot.idle.showLastRunSummary && workedForText !== undefined) {
                let summary = `Worked for ${workedForText}.`;
                if (
                    snapshot.idle.showTokensPerSecond &&
                    tokensPerSecond !== undefined &&
                    Number.isFinite(tokensPerSecond) &&
                    tokensPerSecond > 0
                ) {
                    summary = `${summary} [${tokensPerSecond.toFixed(1)} tok/s]`;
                }

                parts.push(summary);
            }

            if (idleSegments.length > 0) {
                parts.push(idleSegments);
            }

            const text = parts.join(" · ");
            const truncated = truncateToWidth(text, Math.max(0, width - 1), "");
            return [theme.fg("dim", ` ${truncated}`)];
        },
        invalidate() {},
    }));
}
