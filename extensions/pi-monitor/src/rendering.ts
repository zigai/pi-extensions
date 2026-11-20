import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { call, output, stack, text, type GlowupRenderer } from "@zigai/pi-glowup/protocol";
import { Type, type StaticDecode } from "typebox";
import { Compile } from "typebox/compile";
import {
    listArgsValidator,
    listOutputSchema,
    monitorArgsValidator,
    type ListArgs,
    type MonitorArgs,
    type CommandArgs,
    type WebSocketArgs,
    type StopResult,
    monitorSchema,
    commandArgsValidator,
    websocketArgsValidator,
    stopOutputSchema,
    formatDuration,
    type MonitorSnapshot,
} from "./monitors.ts";
import { monitorStatus, plainText, sourceLabel } from "./presentation.ts";

type RenderTheme = Pick<Theme, "fg" | "bold">;

export const notificationDetailsSchema = Type.Object(
    {
        monitor: monitorSchema,
        kind: Type.Enum(["event", "end"]),
        summary: Type.String(),
        text: Type.String(),
    },
    { additionalProperties: false },
);

export type NotificationDetails = StaticDecode<typeof notificationDetailsSchema>;

const COLLAPSED_EVENT_LINES = 6;
const notificationValidator = Compile(notificationDetailsSchema);
const monitorResultValidator = Compile(Type.Object({ details: monitorSchema }));
const stopResultValidator = Compile(Type.Object({ details: stopOutputSchema }));
const listResultValidator = Compile(Type.Object({ details: listOutputSchema }));

export function parseNotificationDetails(value: unknown): NotificationDetails | undefined {
    try {
        return notificationValidator.Parse(value);
    } catch {
        return undefined;
    }
}

const parseCommandArgs: GlowupRenderer<CommandArgs>["parseArgs"] = (value) => {
    const parsed = commandArgsValidator.validate(value);
    if (!parsed.ok) return undefined;
    return parsed.value;
};

const parseWebSocketArgs: GlowupRenderer<WebSocketArgs>["parseArgs"] = (value) => {
    const parsed = websocketArgsValidator.validate(value);
    if (!parsed.ok) return undefined;
    return parsed.value;
};

const parseMonitorArgs: GlowupRenderer<MonitorArgs>["parseArgs"] = (value) => {
    const parsed = monitorArgsValidator.validate(value);
    if (!parsed.ok) return undefined;
    return parsed.value;
};

const parseListArgs: GlowupRenderer<ListArgs>["parseArgs"] = (value) => {
    const parsed = listArgsValidator.validate(value);
    if (!parsed.ok) return undefined;
    return parsed.value;
};

function parseStartResult(value: unknown): StartResult {
    try {
        return { monitor: monitorResultValidator.Parse(value).details };
    } catch {
        return { error: true };
    }
}

function parseStopResult(value: unknown): StopDetails {
    try {
        return stopResultValidator.Parse(value).details;
    } catch {
        return undefined;
    }
}

function parseListResult(value: unknown): ListDetails {
    try {
        return listResultValidator.Parse(value).details;
    } catch {
        return undefined;
    }
}

function previewLines(value: string, expanded: boolean): string[] {
    const lines = plainText(value).split("\n");
    if (expanded || lines.length <= COLLAPSED_EVENT_LINES) return lines;

    const hidden = lines.length - COLLAPSED_EVENT_LINES;
    return [...lines.slice(0, COLLAPSED_EVENT_LINES), `… ${hidden} more lines`];
}

/** Shows an event or end notice delivered as a message. */
export function renderNotification(
    parsed: NotificationDetails | undefined,
    options: { readonly expanded: boolean },
    theme: RenderTheme,
): Component {
    const title = theme.fg("accent", theme.bold("Monitor"));
    if (parsed === undefined) return new Text(`${title} ${theme.fg("error", "unavailable")}`, 1, 0);

    const description = plainText(parsed.monitor.description);
    let header = `${title} ${description}`;
    if (parsed.kind === "end") {
        const status = monitorStatus(parsed.monitor);
        header += ` ${theme.fg(status.tone, status.text)}`;
    }

    const lines = [header];
    if (parsed.kind === "end") lines.push(theme.fg("dim", plainText(parsed.summary)));
    if (parsed.text.length > 0) lines.push(...previewLines(parsed.text, options.expanded));
    return new Text(lines.join("\n"), 1, 0);
}

function monitorLine(monitor: MonitorSnapshot) {
    const status = monitorStatus(monitor);
    let tone: "accent" | "success" | "error" | "dim" = status.tone;
    if (tone === "accent") tone = "success";

    const label = `${monitor.id} ${plainText(monitor.description)}`;

    return text(`${label} · ${status.text}`, {
        parts: [label, { kind: "text", text: ` · ${status.text}`, tone }],
    });
}

type StartResult = { readonly monitor: MonitorSnapshot } | { readonly error: true };

function startedLine(result: StartResult) {
    if ("error" in result) return undefined;

    const { monitor } = result;
    const timeout = formatDuration(monitor.timeoutSeconds * 1_000);

    return text(`${plainText(monitor.description)} · ${monitor.id} · ${timeout} timeout`, {
        parts: [
            plainText(monitor.description),
            { kind: "text", text: ` · ${monitor.id} · ${timeout} timeout`, tone: "dim" },
        ],
    });
}

// The Bash call style highlights the command like Glowup's own Bash calls; the label marks it.
export const commandRendering = {
    version: 3,
    callStyle: { kind: "bash", background: true, label: "Monitor" },
    parseArgs: parseCommandArgs,
    parseResult: parseStartResult,
    renderCall(args) {
        return call(
            { static: "Monitor", running: "Starting Monitor", completed: "Monitoring" },
            { body: text(plainText(args.description)) },
        );
    },
    renderResult: startedLine,
} satisfies GlowupRenderer<CommandArgs, StartResult>;

export const websocketRendering = {
    version: 3,
    parseArgs: parseWebSocketArgs,
    parseResult: parseStartResult,
    renderCall(args) {
        return call(
            {
                static: "Monitor WebSocket",
                running: "Connecting Monitor",
                completed: "Monitoring WebSocket",
            },
            { body: text({ kind: "text", text: args.url, tone: "url" }) },
        );
    },
    renderResult: startedLine,
} satisfies GlowupRenderer<WebSocketArgs, StartResult>;

type StopDetails = StopResult | undefined;

export const stopRendering = {
    version: 3,
    parseArgs: parseMonitorArgs,
    parseResult: parseStopResult,
    renderCall(args) {
        return call(
            { static: "Stop Monitor", running: "Stopping Monitor", completed: "Stopped Monitor" },
            { body: text(args.id) },
        );
    },
    renderResult(result) {
        if (result === undefined) return undefined;

        const line = monitorLine(result.monitor);
        if (result.pending.length === 0) return line;

        return stack([line, output(plainText(result.pending))]);
    },
} satisfies GlowupRenderer<MonitorArgs, StopDetails>;

type ListDetails = StaticDecode<typeof listOutputSchema> | undefined;

export const listRendering = {
    version: 3,
    parseArgs: parseListArgs,
    parseResult: parseListResult,
    renderCall() {
        return call({
            static: "List Monitors",
            running: "Listing Monitors",
            completed: "Listed Monitors",
        });
    },
    renderResult(result) {
        if (result === undefined) return undefined;
        if (result.monitors.length === 0) return text("No monitors.");
        return stack(result.monitors.map(monitorLine));
    },
} satisfies GlowupRenderer<ListArgs, ListDetails>;

/** Plain renderers used when Glowup is not loaded. */
export const renderCommandCall = ((args, theme: RenderTheme): Component => {
    let label = theme.fg("accent", theme.bold("Monitor"));
    const parsed = commandArgsValidator.validate(args);
    if (parsed.ok) label += ` ${plainText(parsed.value.description)}`;

    return new Text(label, 0, 0);
}) satisfies NonNullable<ToolDefinition["renderCall"]>;

export const renderWebSocketCall = ((args, theme: RenderTheme): Component => {
    let label = theme.fg("accent", theme.bold("Monitor WebSocket"));
    const parsed = websocketArgsValidator.validate(args);
    if (parsed.ok) label += ` ${plainText(parsed.value.description)}`;

    return new Text(label, 0, 0);
}) satisfies NonNullable<ToolDefinition["renderCall"]>;

export const renderStopCall = ((args, theme: RenderTheme): Component => {
    let label = theme.fg("accent", theme.bold("Stop monitor"));
    const parsed = monitorArgsValidator.validate(args);
    if (parsed.ok) label += ` ${parsed.value.id}`;

    return new Text(label, 0, 0);
}) satisfies NonNullable<ToolDefinition["renderCall"]>;

export const renderListCall = ((_args, theme: RenderTheme): Component => {
    return new Text(theme.fg("accent", theme.bold("List monitors")), 0, 0);
}) satisfies NonNullable<ToolDefinition["renderCall"]>;

export function renderMonitorSummary(monitor: MonitorSnapshot): string {
    return `${monitor.id} · ${plainText(monitor.description)} · ${monitorStatus(monitor).text} · ${sourceLabel(monitor)}`;
}
