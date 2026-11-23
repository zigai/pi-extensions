import type {
    AgentToolResult,
    Theme,
    ToolDefinition,
    ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { call, output, stack, text, type GlowupRenderer } from "@zigai/pi-glowup/protocol";
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
import { jobOutcomes } from "./job-outcomes.ts";
import {
    commandLabel,
    commandName,
    commandStatus,
    outcomeText,
    plainOutput,
    statusMark,
} from "./presentation.ts";

type StartArgs = Static<typeof startArgsSchema>;
type JobArgs = Static<typeof jobArgsSchema>;
type WaitArgs = Static<typeof waitArgsSchema>;
type WaitResult = { kind: "available"; jobs: CommandOutput[] } | { kind: "unavailable" };
type RenderTheme = Pick<Theme, "fg" | "bold">;

type JobState = Pick<
    CommandOutput["job"],
    "command" | "state" | "exitCode" | "startedAt" | "endedAt"
>;

const COLLAPSED_OUTPUT_LINES = 5;
const OMITTED_OUTPUT = "Earlier output omitted; full log is available in /background.";

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

function jobLabel(job: JobState, theme: RenderTheme): string {
    const { tone } = commandStatus(job);

    return [
        theme.fg(tone, `${statusMark(job)} `),
        theme.bold(commandName(job.command)),
        theme.fg(tone, ` ${outcomeText(job)}`),
    ].join("");
}

function jobLabelNode(job: JobState) {
    const { tone } = commandStatus(job);
    const name = commandName(job.command);

    return text(`${statusMark(job)} ${name} ${outcomeText(job)}`, {
        parts: [
            { kind: "text", text: `${statusMark(job)} `, tone },
            { kind: "text", text: name, bold: true },
            { kind: "text", text: ` ${outcomeText(job)}`, tone },
        ],
    });
}

function outputRows(result: CommandOutput, expanded: boolean, theme: RenderTheme): string[] {
    let rows = plainOutput(result.output).replace(/\n+$/u, "").split("\n");
    if (rows.length === 1 && rows[0] === "") rows = [];

    if (expanded) {
        if (result.truncated) return [theme.fg("dim", OMITTED_OUTPUT), ...rows];
        return rows;
    }

    if (rows.length <= COLLAPSED_OUTPUT_LINES) return rows;

    const hidden = rows.length - COLLAPSED_OUTPUT_LINES;
    let noun = "lines";
    if (hidden === 1) noun = "line";

    return [theme.fg("dim", `… ${hidden} earlier ${noun}`), ...rows.slice(-COLLAPSED_OUTPUT_LINES)];
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

/** Shows how a background job ended under the call that started it. */
export const renderStartResult = ((result, options, theme: RenderTheme, context): Component => {
    const parsed = parseResult(result);
    if (parsed.kind === "unavailable")
        return new Text(theme.fg("error", resultLabel(parsed)), 0, 0);

    const { id } = parsed.job;
    jobOutcomes.watch(id, context.invalidate);

    const branch = theme.fg("dim", "  └ ");

    return {
        render(width) {
            const outcome = jobOutcomes.get(id);
            if (outcome === undefined) {
                if (jobOutcomes.isRunning(id)) return [`${branch}${jobLabel(parsed.job, theme)}`];

                return [`${branch}${theme.fg("dim", "ended without a recorded result")}`];
            }

            const lines = [`${branch}${jobLabel(outcome.job, theme)}`];
            for (const row of outputRows(outcome, options.expanded, theme))
                for (const wrapped of wrapTextWithAnsi(row, Math.max(1, width - 4)))
                    lines.push(`    ${theme.fg("muted", wrapped)}`);

            return lines;
        },
        invalidate() {},
    };
}) satisfies NonNullable<ToolDefinition["renderResult"]>;

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

        if (result.truncated) lines.push(OMITTED_OUTPUT);
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
    const title = theme.fg("accent", theme.bold("Background"));
    if (result.kind === "unavailable")
        return new Text(`${title} ${theme.fg("error", resultLabel(result))}`, 1, 0);

    const lines = [`${title} ${jobLabel(result.job, theme)}`];
    if (options.expanded) lines.push(...outputRows(result, true, theme));
    return new Text(lines.join("\n"), 1, 0);
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
    theme: RenderTheme,
): Component {
    const parsed = parseWaitResult(result);
    if (parsed.kind === "unavailable") return new Text("Background tasks unavailable", 0, 0);
    if (parsed.jobs.length === 0) return new Text("No outstanding background tasks.", 0, 0);

    const lines = parsed.jobs.flatMap((result) => {
        const label = jobLabel(result.job, theme);
        if (!options.expanded) return [label];

        return [label, ...outputRows(result, true, theme)];
    });

    return new Text(lines.join("\n"), 0, 0);
}

export const startRendering = {
    version: 3,
    callStyle: { kind: "bash", background: true },
    parseArgs: parseStart,
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
} satisfies GlowupRenderer<StartArgs>;

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
        if (result.truncated) nodes.push(text(OMITTED_OUTPUT));

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

        return stack(result.jobs.map((job) => jobLabelNode(job.job)));
    },
} satisfies GlowupRenderer<WaitArgs, WaitResult>;
