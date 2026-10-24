import { join, resolve } from "node:path";
import {
    createLocalBashOperations,
    defineTool,
    getAgentDir,
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
    type CommandSnapshot,
} from "./commands.ts";
import { commandLabel, commandStatus, plainOutput, runningShellStatus } from "./presentation.ts";
import { LogViewer } from "./log-viewer.ts";
import {
    renderJobResult,
    renderOutputResult,
    renderStartCall,
    renderStatusCall,
    renderStopCall,
    startRendering,
    statusRendering,
    stopRendering,
} from "./rendering.ts";

function summary(job: CommandSnapshot): string {
    return `${commandLabel(job.command)} · ${commandStatus(job).text}`;
}

function describe(job: CommandSnapshot): string {
    let state = commandStatus(job).text;
    if (job.state === "completed") state = `finished (exit ${job.exitCode})`;

    const lines = [
        `Background command ${state}: ${commandLabel(job.command)}`,
        `Job: ${job.id}`,
        `Directory: ${job.cwd}`,
        `Output: ${job.outputPath}`,
    ];
    if (job.error !== null) lines.push(job.error);
    return lines.join("\n");
}

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
        const commands = new BackgroundCommands(
            createLocalBashOperations(),
            join(getAgentDir(), "background", ctx.sessionManager.getSessionId()),
            (job) => {
                if (active?.owner !== owner) return;

                refresh();
                pi.sendMessage(
                    {
                        customType: "background-command",
                        content: describe(job),
                        display: false,
                        details: job,
                    },
                    { deliverAs: "followUp", triggerTurn: true },
                );

                if (mode !== "tui") {
                    let severity: "info" | "error" = "info";
                    if (job.state === "failed" || (job.exitCode !== null && job.exitCode !== 0))
                        severity = "error";

                    ui?.notify(summary(job), severity);
                }
            },
        );
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
                    "Start a shell command in the background and return immediately with a job ID and output file. Completion automatically notifies you with its exit status. Continue other work instead of polling or sleeping. Run the command directly, without appending &.",
                promptSnippet:
                    "Run shell commands in the background with automatic completion notifications",
                promptGuidelines: [
                    "Use background_start for commands that should run while you continue other work. Completion arrives automatically as a follow-up, including when you are idle.",
                    "Use background_status to inspect a job's output when needed, and background_stop to stop it. Do not poll for completion.",
                ],
                parameters: startArgsSchema,
                outputSchema: commandSchema,
                renderCall: renderStartCall,
                renderResult: renderJobResult,
                async execute(_toolCallId, args, signal, _onUpdate, ctx) {
                    const job = current().start(args.command, resolve(ctx.cwd, args.cwd ?? "."), {
                        signal,
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
                    "Inspect a background command's status and recent combined stdout/stderr. Full output is available at outputPath. Completion notifications are automatic; do not poll this tool.",
                annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
                parameters: jobArgsSchema,
                outputSchema,
                renderCall: renderStatusCall,
                renderResult: renderOutputResult,
                async execute(_toolCallId, { id }) {
                    const output = current().output(id);
                    let text = `${describe(output.job)}\n\n${output.output || "(no output)"}`;
                    if (output.truncated)
                        text +=
                            "\n\n[Output preview truncated; read the output file for the full log.]";

                    return {
                        content: [{ type: "text", text }],
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
                name: "background_stop",
                label: "Stop background command",
                description:
                    "Stop a background command and its process tree. Repeating a stop for a finished job is harmless.",
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
