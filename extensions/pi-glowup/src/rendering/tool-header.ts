import {
    type GlowupRenderTheme,
    muted,
    type GlowupCallState,
    renderBullet,
    actionText,
    dim,
    green,
    red,
    pathText,
} from "./theme.ts";
import { wrapPrefixedLine, makeComponent } from "./component.ts";
import { type Component } from "@earendil-works/pi-tui";
import { formatPathTarget, collapseHome } from "./path.ts";

export type ReadActionArgs = {
    readonly path?: string;
    readonly offset?: number;
    readonly limit?: number;
};

export type FindActionArgs = {
    readonly pattern?: string;
    readonly path?: string;
    readonly limit?: number;
};

export type GrepActionArgs = {
    readonly pattern?: string;
    readonly path?: string;
    readonly glob?: string;
    readonly limit?: number;
};

export type LsActionArgs = {
    readonly path?: string;
    readonly limit?: number;
};

export type MutationSummary = {
    readonly label: string;
    readonly path: string;
    readonly added: number;
    readonly removed: number;
};

function wrapPreviewPhysicalLines(
    text: string | undefined,
    width: number,
    firstPrefix: string,
    restPrefix: string,
    maxPhysicalLines: number | undefined,
    omittedHint: string,
    theme: GlowupRenderTheme,
): string[] {
    if (maxPhysicalLines === undefined || text === undefined) {
        return wrapPrefixedLine(text, width, firstPrefix, restPrefix);
    }

    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const physicalLines = normalized.split("\n");
    const lineBudget = Math.max(1, Math.floor(maxPhysicalLines));
    if (physicalLines.length <= lineBudget) {
        return wrapPrefixedLine(text, width, firstPrefix, restPrefix);
    }

    const visibleText = physicalLines.slice(0, lineBudget).join("\n");
    const omitted = physicalLines.length - lineBudget;
    return [
        ...wrapPrefixedLine(visibleText, width, firstPrefix, restPrefix),
        ...wrapPrefixedLine(
            muted(theme, `… +${omitted} lines (${omittedHint})`),
            width,
            restPrefix,
            restPrefix,
        ),
    ];
}

export type GlowupCallRenderOptions = {
    readonly state: GlowupCallState;
    readonly statusText: string;
    readonly body?: string;
    readonly maxRenderedLines?: number;
    readonly omittedHint?: string;
};

export function renderGlowupCall(
    theme: GlowupRenderTheme,
    options: GlowupCallRenderOptions,
): Component {
    return makeComponent((width) => {
        const bullet = renderBullet(theme, options.state);
        const prefix = `${bullet} ${actionText(theme, options.statusText, { bold: true })} `;
        const restPrefix = dim(theme, "  │ ");
        return wrapPreviewPhysicalLines(
            options.body,
            width,
            prefix,
            restPrefix,
            options.maxRenderedLines,
            options.omittedHint ?? "truncated",
            theme,
        );
    });
}

export function renderGlowupBody(text: string | undefined): Component {
    return makeComponent((width) => wrapPrefixedLine(text, width, "", ""));
}

export function renderGlowupExplore(
    theme: GlowupRenderTheme,
    actions: ReadonlyArray<string | undefined>,
    options: { readonly statusText?: string; readonly state?: GlowupCallState } = {},
): Component {
    return makeComponent((width) => {
        const rendered = wrapPrefixedLine(
            actionText(theme, options.statusText ?? "Explored", { bold: true }),
            width,
            `${renderBullet(theme, options.state ?? "muted")} `,
            "  ",
        );
        const visibleActions = actions.filter((action): action is string => Boolean(action));

        for (const [index, action] of visibleActions.entries()) {
            const prefix = index === 0 ? dim(theme, "  └ ") : "    ";
            rendered.push(...wrapPrefixedLine(action, width, prefix, "    "));
        }

        return rendered;
    });
}

export type MutationCallRenderOptions = {
    readonly body?: Component;
    readonly labelColumnWidth?: number;
    readonly statDigitWidth?: number;
    readonly state?: GlowupCallState;
};

export function renderMutationCall(
    theme: GlowupRenderTheme,
    summary: MutationSummary,
    options: MutationCallRenderOptions = {},
): Component {
    return makeComponent((width) => {
        const stats = formatMutationStats(theme, summary, options.statDigitWidth);
        const body = `${formatPathTarget(theme, summary.path)} ${stats}`;
        const label =
            options.labelColumnWidth === undefined
                ? summary.label
                : summary.label.padEnd(options.labelColumnWidth, " ");
        const prefix = `${renderBullet(theme, options.state ?? "muted")} ${actionText(theme, label, { bold: true })} `;
        return [
            ...wrapPrefixedLine(body, width, prefix, "  "),
            ...(options.body?.render(width) ?? []),
        ];
    });
}

export function formatMutationStats(
    theme: GlowupRenderTheme,
    summary: MutationSummary,
    statDigitWidth: number | undefined,
): string {
    const width = Math.max(
        1,
        statDigitWidth ?? 1,
        String(summary.added).length,
        String(summary.removed).length,
    );
    const added = green(theme, `+${String(summary.added).padStart(width)}`);
    const removed = red(theme, `-${String(summary.removed).padStart(width)}`);
    if (summary.added <= 0) {
        return summary.removed <= 0 ? "" : `(${removed})`;
    }

    return summary.removed <= 0 ? `(${added})` : `(${added} ${removed})`;
}

export function formatReadAction(
    theme: GlowupRenderTheme,
    args: ReadActionArgs,
    options: { readonly isPartial?: boolean } = {},
): string {
    const target = formatPathTarget(theme, args.path, options);
    const range = formatLineRange(args.offset, args.limit);
    if (range !== undefined) {
        return `${actionText(theme, "Read")} ${target}${muted(theme, range)}`;
    }

    return `${actionText(theme, "Read")} ${target}`;
}

export function formatFindAction(theme: GlowupRenderTheme, args: FindActionArgs): string {
    const parts = [`${actionText(theme, "Find")} ${args.pattern ?? "*"}`];
    if (args.path !== undefined && args.path.length > 0) {
        parts.push(`in ${pathText(theme, collapseHome(args.path))}`);
    }

    if (args.limit !== undefined) {
        parts.push(muted(theme, `limit ${args.limit}`));
    }

    return parts.join(" ");
}

export function formatGrepAction(theme: GlowupRenderTheme, args: GrepActionArgs): string {
    const parts = [`${actionText(theme, "Search")} ${args.pattern ?? ""}`.trim()];
    if (args.path !== undefined && args.path.length > 0) {
        parts.push(`in ${pathText(theme, collapseHome(args.path))}`);
    }

    if (args.glob !== undefined && args.glob.length > 0) {
        parts.push(muted(theme, `(${args.glob})`));
    }

    if (args.limit !== undefined) {
        parts.push(muted(theme, `limit ${args.limit}`));
    }

    return parts.join(" ");
}

export function formatLsAction(theme: GlowupRenderTheme, args: LsActionArgs): string {
    const parts = [
        `${actionText(theme, "List")} ${pathText(theme, collapseHome(args.path ?? "."))}`,
    ];
    if (args.limit !== undefined) {
        parts.push(muted(theme, `limit ${args.limit}`));
    }

    return parts.join(" ");
}

function formatLineRange(offset?: number, limit?: number): string | undefined {
    if (offset === undefined && limit === undefined) {
        return undefined;
    }

    const start = offset ?? 1;
    if (limit === undefined) {
        return `:${start}`;
    }

    return `:${start}-${start + limit - 1}`;
}
