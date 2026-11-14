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
    waitArgsSchema,
    waitOutputSchema,
    type CommandSnapshot,
} from "./commands.ts";
import { commandLabel, commandStatus, plainOutput } from "./presentation.ts";

type StartArgs = StaticDecode<typeof startArgsSchema>;
type JobArgs = StaticDecode<typeof jobArgsSchema>;
type WaitArgs = StaticDecode<typeof waitArgsSchema>;
type WaitResult = { kind: "available"; jobs: SavedOutput[] } | { kind: "unavailable" };
type RenderTheme = Pick<Theme, "fg" | "bold">;

// Saved sessions from before task/service support have no kind, and ones from before
// task deadlines have no timing fields. Only the rendering boundary accepts those
// shapes; new tool results still use commandSchema.
const savedCommandSchema = Type.Object(
    {
        ...commandSchema.properties,
        kind: Type.Optional(commandSchema.properties.kind),
        startedAt: Type.Optional(commandSchema.properties.startedAt),
        endedAt: Type.Optional(commandSchema.properties.endedAt),
        lastOutputAt: Type.Optional(commandSchema.properties.lastOutputAt),
        timeoutSeconds: Type.Optional(commandSchema.properties.timeoutSeconds),
    },
    { additionalProperties: false },
);
const savedOutputSchema = Type.Object(
    { ...outputSchema.properties, job: savedCommandSchema },
    { additionalProperties: false },
);

type SavedJob = Omit<StaticDecode<typeof savedCommandSchema>, "kind"> & {
    kind: CommandSnapshot["kind"];
};

type SavedOutput = { job: SavedJob; output: string; truncated: boolean };
export type Result = ({ kind: "available" } & SavedOutput) | { kind: "unavailable" };

const jobResultSchema = Type.Object({ details: savedCommandSchema });
const outputResultSchema = Type.Object({ details: savedOutputSchema });
const savedOutputValidator = Compile(savedOutputSchema);
const startValidator = Compile(startArgsSchema);
const jobValidator = Compile(jobArgsSchema);
const resultValidator = Compile(Type.Union([jobResultSchema, outputResultSchema]));
const waitValidator = Compile(waitArgsSchema);
const waitResultValidator = Compile(
    Type.Object({
        details: Type.Object(
            { ...waitOutputSchema.properties, jobs: Type.Array(savedOutputSchema) },
            { additionalProperties: false },
        ),
    }),
);

function parseWait(value: unknown): WaitArgs | undefined {
    try {
        return waitValidator.Parse(value);
    } catch {
        return undefined;
    }
}

function parseWaitResult(value: unknown): WaitResult {
    try {
        const parsed = waitResultValidator.Parse(value);

        return {
            kind: "available",
            jobs: parsed.details.jobs.map((result) => ({
                ...result,
                job: { ...result.job, kind: result.job.kind ?? "task" },
            })),
        };
    } catch {
        return { kind: "unavailable" };
    }
}

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
        if (Value.Check(savedOutputSchema, parsed.details)) {
            return {
                kind: "available",
                job: { ...parsed.details.job, kind: parsed.details.job.kind ?? "task" },
                output: parsed.details.output,
                truncated: parsed.details.truncated,
            };
        }

        return {
            kind: "available",
            job: { ...parsed.details, kind: parsed.details.kind ?? "task" },
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

export function renderStartCall(args: Partial<StartArgs>, theme: RenderTheme): Component {
    const parsed = parseStart(args);
    let title = "Background";
    if (parsed !== undefined) title += ` ${parsed.kind ?? "task"}`;

    let label = theme.fg("accent", theme.bold(title));
    if (parsed !== undefined) label += ` ${commandLabel(parsed.command)}`;

    return new Text(label, 0, 0);
}

export function renderStatusCall(_args: JobArgs, theme: RenderTheme): Component {
    return new Text(theme.fg("accent", theme.bold("Background output")), 0, 0);
}

export function renderWaitCall(_args: WaitArgs, theme: RenderTheme): Component {
    return new Text(theme.fg("accent", theme.bold("Wait for background tasks")), 0, 0);
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
        const parsed = savedOutputValidator.Parse(details);
        return {
            kind: "available",
            ...parsed,
            job: { ...parsed.job, kind: parsed.job.kind ?? "task" },
        };
    } catch {
        return { kind: "unavailable" };
    }
}

/** Shows a result delivered as a message: a status line, plus output when expanded. */
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
