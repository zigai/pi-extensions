import { join, resolve } from "node:path";
import {
    createLocalBashOperations,
    defineTool,
    getAgentDir,
    isToolCallEventType,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerExtensionDiagnostics } from "@zigai/pi-extension-internals";
import { registerStatusBarSegment, type StatusBarSegmentHandle } from "@zigai/pi-status-bar/api";
import { withGlowupRendering } from "@zigai/pi-glowup/protocol";
import {
    BackgroundCommands,
    commandSchema,
    jobArgsSchema,
    outputSchema,
    startArgsSchema,
    waitArgsSchema,
    waitOutputSchema,
    type CommandOutput,
    type CommandSnapshot,
} from "./commands.ts";
import {
    commandLabel,
    commandStatus,
    commandTiming,
    plainOutput,
    runningShellStatus,
} from "./presentation.ts";
import { LogViewer } from "./log-viewer.ts";
import {
    renderJobResult,
    renderOutputResult,
    parseResultDetails,
    renderResultMessage,
    renderStartCall,
    renderStatusCall,
    renderStopCall,
    renderWaitCall,
    renderWaitResult,
    startRendering,
    statusRendering,
    stopRendering,
    waitRendering,
} from "./rendering.ts";

function summary(job: CommandSnapshot): string {
    return `${job.kind} · ${commandLabel(job.command)} · ${commandStatus(job).text}`;
}

function describe(job: CommandSnapshot): string {
    let state = commandStatus(job).text;
    if (job.state === "completed") state = `finished (exit ${job.exitCode})`;

    const lines = [
        `Background ${job.kind} ${state}: ${commandLabel(job.command)}`,
        commandTiming(job, Date.now()),
        `Job: ${job.id}`,
        `Directory: ${job.cwd}`,
        `Output: ${job.outputPath}`,
    ];
    if (job.error !== null) lines.push(job.error);
    return lines.join("\n");
}

function describeOutput(result: CommandOutput): string {
    let text = `${describe(result.job)}\n\n${result.output || "(no output)"}`;
    if (result.truncated)
        text += "\n\n[Output preview truncated; read the output file for the full log.]";

    return text;
}

const RESULT_MESSAGE_TYPE = "pi-background.result";

type ActiveSession = {
    readonly owner: symbol;
    readonly commands: BackgroundCommands;
    status: StatusBarSegmentHandle | undefined;
    viewer: LogViewer | undefined;
};

async function disposeViewer(state: ActiveSession): Promise<void> {
    const viewer = state.viewer;
    state.viewer = undefined;
    viewer?.dispose();
    await viewer?.whenIdle();
}

export default function backgroundExtension(pi: ExtensionAPI): void {
    registerExtensionDiagnostics(pi);

    let active: ActiveSession | undefined;
    let generation = 0;

    const refresh = (): void => {
        if (active === undefined) return;

        active.status?.setText(runningShellStatus(active.commands.list()));
    };

    const reset = async (): Promise<void> => {
        generation += 1;

        const previous = active;
        previous?.status?.dispose();
        previous?.viewer?.close();

        const disposed = previous?.commands.dispose();

        active = undefined;
        await Promise.all([disposed, previous?.viewer?.whenIdle()]);
    };

    pi.on("session_start", async (_event, ctx) => {
        const revision = generation + 1;
        await reset();

        if (revision !== generation) return;

        const owner = Symbol("background-session");
        let ui: ExtensionContext["ui"] | undefined;
        if (ctx.hasUI) ui = ctx.ui;

        const mode = ctx.mode;
        const commands = new BackgroundCommands({
            operations: createLocalBashOperations(),
            directory: join(getAgentDir(), "background", ctx.sessionManager.getSessionId()),
            onChange: () => {
                if (active?.owner !== owner) return;

                refresh();
            },
            onResult: (result) => {
                if (active?.owner !== owner) return;

                pi.sendMessage(
                    {
                        customType: RESULT_MESSAGE_TYPE,
                        content: `${describeOutput(result)}\n\nNo wait or status read had collected this result, so it was delivered automatically.`,
                        display: true,
                        details: result,
                    },
                    { triggerTurn: true },
                );
            },
        });
        const state: ActiveSession = {
            owner,
            commands,
            status: undefined,
            viewer: undefined,
        };
        active = state;

        if (mode !== "tui" || ui === undefined) return;

        state.status = registerStatusBarSegment({
            id: "pi-background.shells",
            states: ["active", "idle"],
            side: "right",
        });
    });
    pi.on("session_shutdown", reset);
    pi.registerMessageRenderer(RESULT_MESSAGE_TYPE, (message, options, theme) =>
        renderResultMessage(parseResultDetails(message.details), options, theme),
    );
    pi.on("tool_call", (event) => {
        if (!isToolCallEventType("bash", event) && !isToolCallEventType("powershell", event))
            return undefined;

        const timeout = event.input.timeout;
        if (timeout !== undefined && Number.isFinite(timeout) && timeout > 0 && timeout <= 120)
            return undefined;

        return {
            block: true,
            reason: "This foreground command has not started. Choose an explicit timeout of at most 120 seconds only when it is safe to stop the command at that deadline. For longer or uncertain work, use background_start with a timeout near the longest the command should need; its result arrives as a message when it finishes.",
        };
    });

    const current = (): BackgroundCommands => {
        if (active === undefined)
            throw new Error("Background commands are not ready for this session.");

        return active.commands;
    };

    pi.registerCommand("background", {
        description: "Inspect background command output or stop running jobs",
        getArgumentCompletions(prefix) {
            if (active === undefined) return null;
            return active.commands
                .list()
                .filter(
                    (job) =>
                        job.id.startsWith(prefix) || commandLabel(job.command).startsWith(prefix),
                )
                .map((job) => ({
                    value: job.id,
                    label: commandLabel(job.command),
                    description: commandStatus(job).text,
                }));
        },
        async handler(args, ctx) {
            const state = active;
            if (state === undefined || !ctx.hasUI) return;

            const jobs = state.commands.list();
            if (jobs.length === 0) {
                ctx.ui.notify("No background commands in this session.", "info");
                return;
            }

            let id = args.trim();
            if (id.length === 0) {
                const labels = jobs.map((job, index) => `#${index + 1} ${summary(job)}`);
                const selected = await ctx.ui.select("Background commands", labels);
                if (active !== state || selected === undefined) return;

                const selectedJob = jobs.find((_job, index) => labels[index] === selected);
                if (selectedJob === undefined) return;

                id = selectedJob.id;
            }

            try {
                const job = state.commands.get(id);
                const actions = ["View output", "View details"];
                if (job.state === "running") actions.push("Stop command");

                actions.push("Close");

                const action = await ctx.ui.select(summary(job), actions);
                if (active !== state || action === undefined || action === "Close") return;

                if (action === "Stop command") await state.commands.stop(id);
                else if (action === "View details")
                    await ctx.ui.editor(
                        "Background command details (changes are not saved)",
                        plainOutput(describe(state.commands.get(id))),
                    );
                else if (action === "View output") {
                    if (state.viewer !== undefined) return;
                    try {
                        await ctx.ui.custom<void>(
                            (tui, _theme, _keys, done) => {
                                const viewer = new LogViewer(
                                    job.outputPath,
                                    `Background output · ${summary(job)}`,
                                    {
                                        rows: () => tui.terminal.rows,
                                        requestRender: () => tui.requestRender(),
                                        close: () => done(),
                                    },
                                );

                                state.viewer = viewer;
                                if (active !== state) viewer.close();
                                return viewer;
                            },
                            {
                                overlay: true,
                                overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 },
                            },
                        );
                    } finally {
                        await disposeViewer(state);
                    }
                }

                if (active === state) refresh();
            } catch {
                if (active === state)
                    ctx.ui.notify("Could not open the background command or its output.", "error");
            }
        },
    });

    pi.registerTool(
        withGlowupRendering(
            defineTool({
                name: "background_start",
                label: "Background command",
                description:
                    "Start a shell command in the background and return immediately with a job ID and output file. Use for long or uncertain-duration commands, even without independent work. Foreground shell calls require an explicit timeout of at most 120 seconds. Use kind: task (default) for finite work or service for servers/watchers. A task is stopped with its child processes when its timeout passes. When a task or service ends, its result arrives as a message, even after your turn has ended, unless background_wait, background_status, or background_stop already collected it. Run the command directly, without appending &.",
                promptSnippet:
                    "Run finite tasks or long-lived services while doing independent work",
                promptGuidelines: [
                    "Set background_start timeout near the longest the task should need, so a hung command is stopped instead of running for hours.",
                    "While background tasks run, continue independent work. When only waiting is left, end your turn and say what you are waiting for: each background_start result arrives as a message that starts your next turn. Use background_wait only when a result is due within a couple of minutes.",
                    "Start servers and watchers with background_start kind: service. Verify readiness instead of waiting for them to exit; services may keep running after your final response.",
                    "Use background_status to inspect output and background_stop to stop jobs. If a background task has shown no progress for longer than it should, stop it and investigate instead of waiting again. Do not poll or sleep.",
                ],
                parameters: startArgsSchema,
                outputSchema: commandSchema,
                renderCall: renderStartCall,
                renderResult: renderJobResult,
                async execute(_toolCallId, args, signal, _onUpdate, ctx) {
                    const job = current().start(args.command, resolve(ctx.cwd, args.cwd ?? "."), {
                        signal,
                        kind: args.kind,
                        timeout: args.timeout,
                    });

                    refresh();

                    return {
                        content: [{ type: "text", text: describe(job) }],
                        details: job,
                        structuredContent: job,
                    };
                },
            }),
            startRendering,
        ),
    );

    pi.registerTool(
        withGlowupRendering(
            defineTool({
                name: "background_status",
                label: "Background output",
                description:
                    "Inspect a task or service's status, run time, time since its last output, and recent combined stdout/stderr. Full output is available at outputPath. Reading a finished task collects its result. Do not poll to wait for completion.",
                annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
                parameters: jobArgsSchema,
                outputSchema,
                renderCall: renderStatusCall,
                renderResult: renderOutputResult,
                async execute(_toolCallId, { id }) {
                    const output = current().output(id);
                    return {
                        content: [{ type: "text", text: describeOutput(output) }],
                        details: output,
                        structuredContent: output,
                    };
                },
            }),
            statusRendering,
        ),
    );

    pi.registerTool(
        withGlowupRendering(
            defineTool({
                name: "background_wait",
                label: "Wait for background tasks",
                description:
                    "Wait for selected finite tasks, or all outstanding tasks when ids is omitted. Returns when they finish or after 60 seconds by default (maximum 120); running jobs are not stopped. Each running task shows its run time and time since its last output. A timedOut result is a checkpoint, not a reason to wait again: stop a task that has gone quiet for longer than it should, or end your turn and let its result arrive as a message. Completed results are collected. Excludes services and previously collected tasks by default. Cancelling only the wait leaves commands running.",
                parameters: waitArgsSchema,
                outputSchema: waitOutputSchema,
                renderCall: renderWaitCall,
                renderResult: renderWaitResult,
                async execute(_toolCallId, { ids, timeout }, signal) {
                    const result = await current().wait(ids, { signal, timeout });
                    refresh();
                    let text = "No outstanding background tasks.";
                    if (result.jobs.length > 0)
                        text = result.jobs.map(describeOutput).join("\n\n---\n\n");

                    if (result.timedOut)
                        text =
                            "Wait checkpoint reached. Commands are still running. Do not wait again by default. If a task's output shows no progress for longer than it should, stop it with background_stop and investigate. Otherwise continue other work, or end your turn: each result arrives as a message when its task finishes.\n\n" +
                            text;

                    return {
                        content: [{ type: "text", text }],
                        details: result,
                        structuredContent: result,
                    };
                },
            }),
            waitRendering,
        ),
    );

    pi.registerTool(
        withGlowupRendering(
            defineTool({
                name: "background_stop",
                label: "Stop background command",
                description:
                    "Stop a background command and its process tree, dismissing it from default waits. Repeating a stop for a finished job is harmless. Output remains available through background_status or an explicit task wait.",
                parameters: jobArgsSchema,
                outputSchema: commandSchema,
                renderCall: renderStopCall,
                renderResult: renderJobResult,
                async execute(_toolCallId, { id }, signal) {
                    signal?.throwIfAborted();
                    const job = await current().stop(id);

                    refresh();

                    return {
                        content: [{ type: "text", text: describe(job) }],
                        details: job,
                        structuredContent: job,
                    };
                },
            }),
            stopRendering,
        ),
    );
}
