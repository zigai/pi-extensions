import type {
    AgentToolResult,
    Theme,
    ToolDefinition,
    ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { call, empty, output, stack, text, type GlowupRenderer } from "@zigai/pi-glowup/protocol";
import { type Static } from "@earendil-works/pi-schema";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import {
    commandSchema,
    jobArgsSchema,
    jobValidator,
    outputSchema,
    startArgsSchema,
    startValidator,
    waitArgsSchema,
    waitValidator,
    waitOutputSchema,
    type CommandOutput,
} from "./commands.ts";
import { commandLabel, commandStatus, plainOutput } from "./presentation.ts";

type StartArgs = Static<typeof startArgsSchema>;
type JobArgs = Static<typeof jobArgsSchema>;
type WaitArgs = Static<typeof waitArgsSchema>;
type WaitResult = { kind: "available"; jobs: CommandOutput[] } | { kind: "unavailable" };
type RenderTheme = Pick<Theme, "fg" | "bold">;

export type Result = ({ kind: "available" } & CommandOutput) | { kind: "unavailable" };

const jobResultSchema = Type.Object({ details: commandSchema });
const outputResultSchema = Type.Object({ details: outputSchema });
const outputValidator = Compile(outputSchema);
const resultValidator = Compile(Type.Union([jobResultSchema, outputResultSchema]));
const waitResultValidator = Compile(Type.Object({ details: waitOutputSchema }));

const parseWait: GlowupRenderer<WaitArgs>["parseArgs"] = (value) => {
    const parsed = waitValidator.validate(value);
    if (!parsed.ok) return undefined;
    return parsed.value;
};

function parseWaitResult(value: unknown): WaitResult {
    try {
        return { kind: "available", jobs: waitResultValidator.Parse(value).details.jobs };
    } catch {
        return { kind: "unavailable" };
    }
}

const parseStart: GlowupRenderer<StartArgs>["parseArgs"] = (value) => {
    const parsed = startValidator.validate(value);
    if (!parsed.ok) return undefined;
    return parsed.value;
};

const parseJob: GlowupRenderer<JobArgs>["parseArgs"] = (value) => {
    const parsed = jobValidator.validate(value);
    if (!parsed.ok) return undefined;
    return parsed.value;
};

function parseResult(value: unknown): Result {
    try {
        const parsed = resultValidator.Parse(value);
        if (Value.Check(outputSchema, parsed.details)) {
            return { kind: "available", ...parsed.details };
        }

        return {
            kind: "available",
            job: parsed.details,
            output: "",
            truncated: false,
        };
    } catch {
        return { kind: "unavailable" };
    }
}

function resultLabel(result: Result): string {
    if (result.kind === "unavailable") return "Background command unavailable";
    return `${result.job.kind} · ${commandLabel(result.job.command)} · ${commandStatus(result.job).text}`;
}

export const renderStartCall = ((args, theme: RenderTheme): Component => {
    const parsed = startValidator.validate(args);
    if (!parsed.ok) return new Text(theme.fg("accent", theme.bold("Background")), 0, 0);

    const { kind, command } = parsed.value;
    const title = theme.fg("accent", theme.bold(`Background ${kind ?? "task"}`));
    const label = `${title} ${commandLabel(command)}`;
    return new Text(label, 0, 0);
}) satisfies NonNullable<ToolDefinition["renderCall"]>;

export const renderStatusCall = ((_args, theme: RenderTheme): Component => {
    return new Text(theme.fg("accent", theme.bold("Background output")), 0, 0);
}) satisfies NonNullable<ToolDefinition["renderCall"]>;

export const renderWaitCall = ((_args, theme: RenderTheme): Component => {
    return new Text(theme.fg("accent", theme.bold("Wait for background tasks")), 0, 0);
}) satisfies NonNullable<ToolDefinition["renderCall"]>;

export const renderStopCall = ((_args, theme: RenderTheme): Component => {
    return new Text(theme.fg("accent", theme.bold("Stop background command")), 0, 0);
}) satisfies NonNullable<ToolDefinition["renderCall"]>;

export function renderJobResult(result: AgentToolResult<unknown>): Component {
    const parsed = parseResult(result);
    if (parsed.kind === "available" && parsed.job.state === "running") {
        return { render: () => [], invalidate() {} };
    }

    return new Text(resultLabel(parsed), 0, 0);
}

function outputLines(result: Result, expanded: boolean): string[] {
    const lines = [resultLabel(result)];
    if (result.kind === "available" && expanded) {
        lines.push(plainOutput(result.output));

        if (result.truncated)
            lines.push("Earlier output omitted; full log is available in /background.");
    }

    return lines;
}

export function parseResultDetails(details: unknown): Result {
    try {
        return { kind: "available", ...outputValidator.Parse(details) };
    } catch {
        return { kind: "unavailable" };
    }
}

export function renderResultMessage(
    result: Result,
    options: Pick<ToolRenderResultOptions, "expanded">,
    theme: RenderTheme,
): Component {
    let tone: "accent" | "success" | "error" | "dim" = "error";
    if (result.kind === "available") tone = commandStatus(result.job).tone;

    const [label = "", ...rest] = outputLines(result, options.expanded);
    const title = theme.fg("accent", theme.bold("Background result"));
    return new Text([`${title} ${theme.fg(tone, label)}`, ...rest].join("\n"), 1, 0);
}

export function renderOutputResult(
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
): Component {
    return new Text(outputLines(parseResult(result), options.expanded).join("\n"), 0, 0);
}

export function renderWaitResult(
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
): Component {
    const parsed = parseWaitResult(result);
    if (parsed.kind === "unavailable") return new Text("Background tasks unavailable", 0, 0);
    if (parsed.jobs.length === 0) return new Text("No outstanding background tasks.", 0, 0);

    const lines = parsed.jobs.flatMap((job) =>
        outputLines({ kind: "available", ...job }, options.expanded),
    );
    return new Text(lines.join("\n"), 0, 0);
}

export const startRendering = {
    version: 3,
    callStyle: { kind: "bash", background: true },
    parseArgs: parseStart,
    parseResult,
    renderCall(args) {
        let kind = "Task";
        if (args.kind === "service") kind = "Service";

        return call(
            {
                static: `Background ${kind}`,
                running: `Starting Background ${kind}`,
                completed: `Started Background ${kind}`,
            },
            { body: text(commandLabel(args.command)) },
        );
    },
    renderResult(result) {
        if (result.kind === "unavailable")
            return text({ kind: "text", text: resultLabel(result), tone: "error" });

        return empty();
    },
} satisfies GlowupRenderer<StartArgs, Result>;

export const statusRendering = {
    version: 3,
    parseArgs: parseJob,
    parseResult,
    renderCall(_args) {
        return call({
            static: "Background Output",
            running: "Reading Background Output",
            completed: "Read Background Output",
        });
    },
    renderResult(result) {
        if (result.kind === "unavailable")
            return text({ kind: "text", text: resultLabel(result), tone: "error" });

        const nodes = [
            text({ kind: "text", text: resultLabel(result), tone: commandStatus(result.job).tone }),
            output(result.output),
        ];
        if (result.truncated)
            nodes.push(text("Earlier output omitted; full log is available in /background."));

        return stack(nodes);
    },
} satisfies GlowupRenderer<JobArgs, Result>;

export const stopRendering = {
    version: 3,
    parseArgs: parseJob,
    parseResult,
    renderCall(_args) {
        return call({
            static: "Stop Background",
            running: "Stopping Background",
            completed: "Stopped Background",
        });
    },
    renderResult(result) {
        if (result.kind === "unavailable")
            return text({ kind: "text", text: resultLabel(result), tone: "error" });

        return text({
            kind: "text",
            text: resultLabel(result),
            tone: commandStatus(result.job).tone,
        });
    },
} satisfies GlowupRenderer<JobArgs, Result>;

export const waitRendering = {
    version: 3,
    parseArgs: parseWait,
    parseResult: parseWaitResult,
    renderCall(_args) {
        return call({
            static: "Wait for Background Tasks",
            running: "Waiting for Background Tasks",
            completed: "Collected Background Tasks",
        });
    },
    renderResult(result) {
        if (result.kind === "unavailable")
            return text({ kind: "text", text: "Background tasks unavailable", tone: "error" });
        if (result.jobs.length === 0) return text("No outstanding background tasks.");

        return stack(
            result.jobs.map((job) => statusRendering.renderResult({ kind: "available", ...job })),
        );
    },
} satisfies GlowupRenderer<WaitArgs, WaitResult>;
