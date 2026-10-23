import type {
    AgentToolResult,
    Theme,
    ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { call, empty, output, stack, text, type GlowupRenderer } from "@zigai/pi-glowup/protocol";
import { Type, type StaticDecode } from "typebox";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import {
    commandSchema,
    jobArgsSchema,
    outputSchema,
    startArgsSchema,
    type CommandSnapshot,
} from "./commands.ts";
import { commandLabel, commandStatus, plainOutput } from "./presentation.ts";

type StartArgs = StaticDecode<typeof startArgsSchema>;
type JobArgs = StaticDecode<typeof jobArgsSchema>;
type RenderTheme = Pick<Theme, "fg" | "bold">;

type Result =
    | { kind: "available"; job: CommandSnapshot; output: string; truncated: boolean }
    | { kind: "unavailable" };

const jobResultSchema = Type.Object({ details: commandSchema });
const outputResultSchema = Type.Object({ details: outputSchema });
const startValidator = Compile(startArgsSchema);
const jobValidator = Compile(jobArgsSchema);
const resultValidator = Compile(Type.Union([jobResultSchema, outputResultSchema]));

function parseStart(value: unknown): StartArgs | undefined {
    try {
        return startValidator.Parse(value);
    } catch {
        return undefined;
    }
}

function parseJob(value: unknown): JobArgs | undefined {
    try {
        return jobValidator.Parse(value);
    } catch {
        return undefined;
    }
}

function parseResult(value: unknown): Result {
    try {
        const parsed = resultValidator.Parse(value);
        if (Value.Check(outputSchema, parsed.details)) {
            return {
                kind: "available",
                job: parsed.details.job,
                output: parsed.details.output,
                truncated: parsed.details.truncated,
            };
        }

        return { kind: "available", job: parsed.details, output: "", truncated: false };
    } catch {
        return { kind: "unavailable" };
    }
}

function resultLabel(result: Result): string {
    if (result.kind === "unavailable") return "Background command unavailable";
    return `${commandLabel(result.job.command)} · ${commandStatus(result.job).text}`;
}

export function renderStartCall(args: Partial<StartArgs>, theme: RenderTheme): Component {
    const parsed = parseStart(args);
    let label = theme.fg("accent", theme.bold("Background"));
    if (parsed !== undefined) label += ` ${commandLabel(parsed.command)}`;

    return new Text(label, 0, 0);
}

export function renderStatusCall(_args: JobArgs, theme: RenderTheme): Component {
    return new Text(theme.fg("accent", theme.bold("Background output")), 0, 0);
}

export function renderStopCall(_args: JobArgs, theme: RenderTheme): Component {
    return new Text(theme.fg("accent", theme.bold("Stop background command")), 0, 0);
}

export function renderJobResult(result: AgentToolResult<unknown>): Component {
    const parsed = parseResult(result);
    if (parsed.kind === "available" && parsed.job.state === "running") {
        return { render: () => [], invalidate() {} };
    }

    return new Text(resultLabel(parsed), 0, 0);
}

export function renderOutputResult(
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
): Component {
    const parsed = parseResult(result);
    const lines = [resultLabel(parsed)];
    if (parsed.kind === "available" && options.expanded) {
        lines.push(plainOutput(parsed.output));

        if (parsed.truncated)
            lines.push("Earlier output omitted; full log is available in /background.");
    }

    return new Text(lines.join("\n"), 0, 0);
}

export const startRendering = {
    version: 3,
    parseArgs: parseStart,
    parseResult,
    renderCall(args) {
        return call(
            {
                static: "Background",
                running: "Starting Background",
                completed: "Started Background",
            },
            { body: text(args.command) },
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
