/**
 * Pi Branch
 *
 * Adds `/branch` to fork the current Pi session into one or more parallel
 * Pi processes in tmux/Ghostty. Each child session starts from the current
 * committed branch state and diverges independently.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerTypedCommand } from "pi-typed-commands";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";

const MAX_FORK_COUNT = 10;

const GHOSTTY_SPLIT_SCRIPT = `on run argv
	set targetCwd to item 1 of argv
	set startupInput to item 2 of argv
	tell application "Ghostty"
		set cfg to new surface configuration
		set initial working directory of cfg to targetCwd
		set initial input of cfg to startupInput
		if (count of windows) > 0 then
			try
				set frontWindow to front window
				set targetTerminal to focused terminal of selected tab of frontWindow
				split targetTerminal direction right with configuration cfg
			on error
				new window with configuration cfg
			end try
		else
			new window with configuration cfg
		end if
		activate
	end tell
end run`;

const GHOSTTY_WINDOW_SCRIPT = `on run argv
	set targetCwd to item 1 of argv
	set startupInput to item 2 of argv
	tell application "Ghostty"
		set cfg to new surface configuration
		set initial working directory of cfg to targetCwd
		set initial input of cfg to startupInput
		new window with configuration cfg
		activate
	end tell
end run`;

type LaunchMode = "windows" | "panes";
type LaunchTarget = "tmux-window" | "tmux-pane" | "ghostty-split" | "ghostty-window";

type ParsedArgs = {
    count: number;
    mode: LaunchMode;
    prompt: string;
    keepOpen: boolean;
};

type BranchTypedArgs = {
    count: number;
    panes: boolean;
    keepOpen: boolean;
    prompt?: string;
};

type SessionInfoEntry = {
    type: "session_info";
    id: string;
    parentId: string | null;
    timestamp: string;
    name: string;
};

function shellQuote(value: string): string {
    if (value.length === 0) {
        return "''";
    }

    return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function getPiInvocationParts(): string[] {
    const currentScript = process.argv[1];
    if (currentScript !== undefined && currentScript.length > 0 && existsSync(currentScript)) {
        return [process.execPath, currentScript];
    }

    const execName = path.basename(process.execPath).toLowerCase();
    const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
    if (!isGenericRuntime) {
        return [process.execPath];
    }

    return ["pi"];
}

function currentModelArg(ctx: ExtensionCommandContext): string | undefined {
    const model = ctx.model;
    if (model === undefined) {
        return undefined;
    }

    const provider = model.provider.trim();
    const id = model.id.trim();
    if (provider.length === 0 || id.length === 0) {
        return undefined;
    }

    return `${provider}/${id}`;
}

function buildPiCommandParts(
    sessionFile: string | undefined,
    prompt: string,
    modelArg: string | undefined,
): string[] {
    const commandParts = [...getPiInvocationParts()];

    if (modelArg !== undefined) {
        commandParts.push("--model", modelArg);
    }

    if (sessionFile !== undefined) {
        commandParts.push("--session", sessionFile);
    }

    if (prompt.length > 0) {
        commandParts.push(prompt);
    }

    return commandParts;
}

function buildPiShellCommand(
    sessionFile: string | undefined,
    prompt: string,
    modelArg: string | undefined,
    keepOpen: boolean,
): string {
    const piCommand = buildPiCommandParts(sessionFile, prompt, modelArg).map(shellQuote).join(" ");
    if (!keepOpen) {
        return `exec ${piCommand}`;
    }

    return `${piCommand}; exec "\${SHELL:-/bin/sh}"`;
}

function buildPiStartupInput(
    sessionFile: string | undefined,
    prompt: string,
    modelArg: string | undefined,
    keepOpen: boolean,
): string {
    return `${buildPiShellCommand(sessionFile, prompt, modelArg, keepOpen)}\n`;
}

function isTmux(): boolean {
    return (
        process.env.TMUX !== undefined ||
        process.env.TMUX_PANE !== undefined ||
        process.env.TERM_PROGRAM === "tmux"
    );
}

function getLaunchTargets(mode: LaunchMode): LaunchTarget[] {
    const targets: LaunchTarget[] = [];

    if (isTmux()) {
        if (mode === "panes") {
            targets.push("tmux-pane");
        } else {
            targets.push("tmux-window");
        }
    }

    if (process.platform === "darwin") {
        if (mode === "panes") {
            targets.push("ghostty-split");
        } else {
            targets.push("ghostty-window");
        }
    } else if (process.platform === "linux") {
        targets.push("ghostty-window");
    }

    return targets;
}

function describeLaunchTarget(target: LaunchTarget): string {
    switch (target) {
        case "tmux-window":
            return "a new tmux window";
        case "tmux-pane":
            return "a new tmux pane";
        case "ghostty-split":
            return "a new Ghostty split";
        case "ghostty-window":
            return "a new Ghostty window";
    }
}

async function getCurrentTmuxWindowTarget(pi: ExtensionAPI): Promise<string | undefined> {
    const targetPane = process.env.TMUX_PANE?.trim();
    if (targetPane === undefined || targetPane.length === 0) {
        return undefined;
    }

    try {
        const result = await pi.exec("tmux", [
            "display-message",
            "-p",
            "-t",
            targetPane,
            "#{window_id}",
        ]);
        if (result.code !== 0) {
            return undefined;
        }

        const targetWindow = result.stdout?.trim();
        if (targetWindow === undefined || targetWindow.length === 0) {
            return undefined;
        }

        return targetWindow;
    } catch {
        return undefined;
    }
}

function parseTmuxWindowId(stdout: string | undefined): string | undefined {
    const output = stdout?.trim();
    if (output === undefined || output.length === 0) {
        return undefined;
    }

    return output.split(/\s+/)[0];
}

function formatExecFailure(result: { code: number; stdout?: string; stderr?: string }): string {
    const stderr = result.stderr?.trim();
    if (stderr !== undefined && stderr.length > 0) {
        return stderr;
    }

    const stdout = result.stdout?.trim();
    if (stdout !== undefined && stdout.length > 0) {
        return stdout;
    }

    return `exit code ${result.code}`;
}

function formatUnknownError(error: unknown): string {
    if (error instanceof Error && error.message.length > 0) {
        return error.message;
    }

    return String(error);
}

function parseTypedArgs(args: BranchTypedArgs): ParsedArgs {
    let mode: LaunchMode = "windows";
    if (args.panes) {
        mode = "panes";
    }

    return {
        count: args.count,
        mode,
        prompt: args.prompt ?? "",
        keepOpen: args.keepOpen,
    };
}

function buildForkName(baseName: string, index: number): string {
    const branchNumber = index + 1;
    return `${baseName} ${branchNumber}`;
}

function getBaseSessionName(pi: ExtensionAPI, ctx: ExtensionCommandContext): string {
    const sessionName = pi.getSessionName();
    if (sessionName !== undefined && sessionName.trim().length > 0) {
        return sessionName.trim();
    }

    return path.basename(ctx.cwd) || "Pi session";
}

async function createForkedSession(
    ctx: ExtensionCommandContext,
    sessionName: string,
): Promise<string | undefined> {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile === undefined) {
        return undefined;
    }

    const sessionDir = path.dirname(sessionFile);
    const branchEntries = ctx.sessionManager.getBranch();
    const currentHeader = ctx.sessionManager.getHeader();

    const timestamp = new Date().toISOString();
    const fileTimestamp = timestamp.replaceAll(/[:.]/g, "-");
    const newSessionId = randomUUID();
    const newSessionFile = path.join(sessionDir, `${fileTimestamp}_${newSessionId}.jsonl`);

    let version = 3;
    if (currentHeader?.version !== undefined) {
        version = currentHeader.version;
    }

    let cwd = ctx.cwd;
    if (currentHeader?.cwd !== undefined) {
        cwd = currentHeader.cwd;
    }

    const newHeader = {
        type: "session",
        version,
        id: newSessionId,
        timestamp,
        cwd,
        parentSession: sessionFile,
    };

    const leafId = ctx.sessionManager.getLeafId();
    const sessionInfoEntry: SessionInfoEntry = {
        type: "session_info",
        id: randomUUID(),
        parentId: leafId,
        timestamp,
        name: sessionName,
    };

    const lines =
        [
            JSON.stringify(newHeader),
            ...branchEntries.map((entry) => JSON.stringify(entry)),
            JSON.stringify(sessionInfoEntry),
        ].join("\n") + "\n";

    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(newSessionFile, lines, "utf8");

    return newSessionFile;
}

async function launchForkedPi(
    pi: ExtensionAPI,
    target: LaunchTarget,
    ctx: ExtensionCommandContext,
    sessionFile: string | undefined,
    prompt: string,
    keepOpen: boolean,
    launchName: string,
    tmuxWindowTarget: string | undefined,
) {
    const modelArg = currentModelArg(ctx);

    switch (target) {
        case "tmux-window": {
            const tmuxArgs = ["new-window", "-a", "-P", "-F", "#{window_id}"];
            if (tmuxWindowTarget !== undefined) {
                tmuxArgs.push("-t", tmuxWindowTarget);
            }
            tmuxArgs.push(
                "-n",
                launchName,
                "-c",
                ctx.cwd,
                buildPiShellCommand(sessionFile, prompt, modelArg, keepOpen),
            );
            return pi.exec("tmux", tmuxArgs);
        }
        case "tmux-pane": {
            const tmuxArgs = ["split-window", "-h", "-c", ctx.cwd];
            const targetPane = process.env.TMUX_PANE?.trim();
            if (targetPane !== undefined && targetPane.length > 0) {
                tmuxArgs.push("-t", targetPane);
            }
            tmuxArgs.push(buildPiShellCommand(sessionFile, prompt, modelArg, keepOpen));
            return pi.exec("tmux", tmuxArgs);
        }
        case "ghostty-split":
            return pi.exec("osascript", [
                "-e",
                GHOSTTY_SPLIT_SCRIPT,
                "--",
                ctx.cwd,
                buildPiStartupInput(sessionFile, prompt, modelArg, keepOpen),
            ]);
        case "ghostty-window":
            if (process.platform === "darwin") {
                return pi.exec("osascript", [
                    "-e",
                    GHOSTTY_WINDOW_SCRIPT,
                    "--",
                    ctx.cwd,
                    buildPiStartupInput(sessionFile, prompt, modelArg, keepOpen),
                ]);
            }

            if (keepOpen) {
                return pi.exec("ghostty", [
                    "+new-window",
                    `--working-directory=${ctx.cwd}`,
                    "-e",
                    "/bin/sh",
                    "-c",
                    buildPiShellCommand(sessionFile, prompt, modelArg, keepOpen),
                ]);
            }

            return pi.exec("ghostty", [
                "+new-window",
                `--working-directory=${ctx.cwd}`,
                "-e",
                ...buildPiCommandParts(sessionFile, prompt, modelArg),
            ]);
    }
}

async function launchOneFork(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    launchTargets: LaunchTarget[],
    prompt: string,
    keepOpen: boolean,
    launchName: string,
    tmuxWindowTarget: string | undefined,
): Promise<{
    launchedVia?: LaunchTarget;
    sessionFile?: string;
    failures: string[];
    tmuxWindowId?: string;
}> {
    const forkedSessionFile = await createForkedSession(ctx, launchName);
    const failures: string[] = [];

    for (const target of launchTargets) {
        try {
            const result = await launchForkedPi(
                pi,
                target,
                ctx,
                forkedSessionFile,
                prompt,
                keepOpen,
                launchName,
                tmuxWindowTarget,
            );
            if (result.code === 0) {
                let tmuxWindowId: string | undefined;
                if (target === "tmux-window") {
                    tmuxWindowId = parseTmuxWindowId(result.stdout);
                }

                return {
                    launchedVia: target,
                    sessionFile: forkedSessionFile,
                    failures,
                    tmuxWindowId,
                };
            }

            failures.push(`${describeLaunchTarget(target)}: ${formatExecFailure(result)}`);
        } catch (error) {
            failures.push(`${describeLaunchTarget(target)}: ${formatUnknownError(error)}`);
        }
    }

    return { sessionFile: forkedSessionFile, failures };
}

async function handleParsedBranch(
    pi: ExtensionAPI,
    parsed: ParsedArgs,
    ctx: ExtensionCommandContext,
): Promise<void> {
    const launchTargets = getLaunchTargets(parsed.mode);
    if (launchTargets.length === 0) {
        ctx.ui.notify(
            "/branch is supported in tmux, Ghostty on macOS, or Ghostty on Linux.",
            "warning",
        );
        return;
    }

    const wasBusy = !ctx.isIdle();
    const baseSessionName = getBaseSessionName(pi, ctx);
    const successfulSessions: string[] = [];
    const failedReasons: string[] = [];
    let launchedVia: LaunchTarget | undefined;
    let tmuxWindowTarget: string | undefined;
    if (launchTargets.includes("tmux-window")) {
        tmuxWindowTarget = await getCurrentTmuxWindowTarget(pi);
    }

    for (let index = 0; index < parsed.count; index += 1) {
        const launchName = buildForkName(baseSessionName, index);
        const result = await launchOneFork(
            pi,
            ctx,
            launchTargets,
            parsed.prompt,
            parsed.keepOpen,
            launchName,
            tmuxWindowTarget,
        );
        if (result.launchedVia !== undefined) {
            launchedVia = result.launchedVia;
            if (result.sessionFile !== undefined) {
                successfulSessions.push(result.sessionFile);
            }
            if (result.tmuxWindowId !== undefined) {
                tmuxWindowTarget = result.tmuxWindowId;
            }
        } else {
            const reason = result.failures.join("; ") || "no supported launcher available";
            failedReasons.push(reason);
            if (result.sessionFile !== undefined) {
                ctx.ui.notify(`Forked session was created: ${result.sessionFile}`, "info");
            }
        }
    }

    if (successfulSessions.length === 0) {
        ctx.ui.notify(`Failed to launch forked session: ${failedReasons.join("; ")}`, "error");
        return;
    }

    let promptSuffix = "";
    if (parsed.prompt.length > 0) {
        promptSuffix = " and sent prompt";
    }

    let keepOpenSuffix = "";
    if (parsed.keepOpen) {
        keepOpenSuffix = "; shell stays open after Pi exits";
    }

    let targetDescription = "the selected launcher";
    if (launchedVia !== undefined) {
        targetDescription = describeLaunchTarget(launchedVia);
    }

    let forkWord = "forks";
    if (successfulSessions.length === 1) {
        forkWord = "fork";
    }

    ctx.ui.notify(
        `Opened ${successfulSessions.length} ${forkWord} in ${targetDescription}${promptSuffix}${keepOpenSuffix}.`,
        "info",
    );

    if (parsed.count > successfulSessions.length) {
        ctx.ui.notify(
            `Requested ${parsed.count}; ${failedReasons.length} failed: ${failedReasons.join("; ")}`,
            "warning",
        );
    }

    if (wasBusy) {
        ctx.ui.notify(
            "Forked from current committed state (in-flight turn continues in original session).",
            "info",
        );
    }
}

export default function (pi: ExtensionAPI): void {
    registerTypedCommand(pi, "branch", {
        description: "Fork this session into one or more parallel Pi processes",
        formTitle: "Branch session",
        args: {
            count: {
                type: "number",
                integer: true,
                min: 1,
                max: MAX_FORK_COUNT,
                default: 1,
                description: "Number of forks to create",
            },
            panes: {
                type: "boolean",
                default: false,
                description: "Open tmux panes or Ghostty splits instead of windows",
            },
            keepOpen: {
                type: "boolean",
                default: false,
                description: "Keep the terminal shell open after Pi exits",
            },
            prompt: {
                type: "string",
                description: "Optional initial prompt sent to each fork",
                placeholder: "prompt",
                ui: {
                    widget: "textarea",
                    rows: 5,
                },
            },
        },
        handler: async (args, ctx) => {
            await handleParsedBranch(pi, parseTypedArgs(args), ctx);
        },
    });
}
