/**
 * Pi Branch Out
 *
 * Adds `/branch-out` to fork the current Pi session into one or more parallel
 * Pi processes in tmux/Ghostty. Each child session starts from the current
 * committed branch state and diverges independently.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
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

type LaunchTarget = "tmux-split" | "ghostty-split" | "ghostty-window";

type ParsedArgs = {
    count: number;
    prompt: string;
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

function buildPiCommandParts(sessionFile: string | undefined, prompt: string): string[] {
    const commandParts = [...getPiInvocationParts()];

    if (sessionFile !== undefined) {
        commandParts.push("--session", sessionFile);
    }

    if (prompt.length > 0) {
        commandParts.push("--", prompt);
    }

    return commandParts;
}

function buildPiShellCommand(sessionFile: string | undefined, prompt: string): string {
    return `exec ${buildPiCommandParts(sessionFile, prompt).map(shellQuote).join(" ")}`;
}

function buildPiStartupInput(sessionFile: string | undefined, prompt: string): string {
    return `${buildPiShellCommand(sessionFile, prompt)}\n`;
}

function getLaunchTargets(): LaunchTarget[] {
    const targets: LaunchTarget[] = [];
    const inTmux =
        process.env.TMUX !== undefined ||
        process.env.TMUX_PANE !== undefined ||
        process.env.TERM_PROGRAM === "tmux";

    if (inTmux) {
        targets.push("tmux-split");
    }

    if (process.platform === "darwin") {
        targets.push("ghostty-split");
    } else if (process.platform === "linux") {
        targets.push("ghostty-window");
    }

    return targets;
}

function describeLaunchTarget(target: LaunchTarget): string {
    switch (target) {
        case "tmux-split":
            return "a new tmux split";
        case "ghostty-split":
            return "a new Ghostty split";
        case "ghostty-window":
            return "a new Ghostty window";
    }
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

function parseArgs(args: string): ParsedArgs {
    const trimmed = args.trim();
    if (trimmed.length === 0) {
        return { count: 1, prompt: "" };
    }

    const match = /^(\d+)(?:\s+([\s\S]*))?$/.exec(trimmed);
    if (match === null) {
        return { count: 1, prompt: trimmed };
    }

    const parsedCount = Number.parseInt(match[1], 10);
    if (!Number.isSafeInteger(parsedCount) || parsedCount < 1) {
        return { count: 1, prompt: trimmed };
    }

    let count = parsedCount;
    if (count > MAX_FORK_COUNT) {
        count = MAX_FORK_COUNT;
    }

    let prompt = "";
    if (match[2] !== undefined) {
        prompt = match[2].trim();
    }

    return { count, prompt };
}

async function createForkedSession(ctx: ExtensionCommandContext): Promise<string | undefined> {
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

    const lines =
        [JSON.stringify(newHeader), ...branchEntries.map((entry) => JSON.stringify(entry))].join(
            "\n",
        ) + "\n";

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
) {
    switch (target) {
        case "tmux-split": {
            const tmuxArgs = ["split-window", "-h", "-c", ctx.cwd];
            const targetPane = process.env.TMUX_PANE?.trim();
            if (targetPane !== undefined && targetPane.length > 0) {
                tmuxArgs.push("-t", targetPane);
            }
            tmuxArgs.push(buildPiShellCommand(sessionFile, prompt));
            return pi.exec("tmux", tmuxArgs);
        }
        case "ghostty-split":
            return pi.exec("osascript", [
                "-e",
                GHOSTTY_SPLIT_SCRIPT,
                "--",
                ctx.cwd,
                buildPiStartupInput(sessionFile, prompt),
            ]);
        case "ghostty-window":
            return pi.exec("ghostty", [
                "+new-window",
                `--working-directory=${ctx.cwd}`,
                "-e",
                ...buildPiCommandParts(sessionFile, prompt),
            ]);
    }
}

async function launchOneFork(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    launchTargets: LaunchTarget[],
    prompt: string,
): Promise<{ launchedVia?: LaunchTarget; sessionFile?: string; failures: string[] }> {
    const forkedSessionFile = await createForkedSession(ctx);
    const failures: string[] = [];

    for (const target of launchTargets) {
        try {
            const result = await launchForkedPi(pi, target, ctx, forkedSessionFile, prompt);
            if (result.code === 0) {
                return { launchedVia: target, sessionFile: forkedSessionFile, failures };
            }

            failures.push(`${describeLaunchTarget(target)}: ${formatExecFailure(result)}`);
        } catch (error) {
            failures.push(`${describeLaunchTarget(target)}: ${formatUnknownError(error)}`);
        }
    }

    return { sessionFile: forkedSessionFile, failures };
}

async function handleBranchOut(
    pi: ExtensionAPI,
    args: string,
    ctx: ExtensionCommandContext,
): Promise<void> {
    const launchTargets = getLaunchTargets();
    if (launchTargets.length === 0) {
        ctx.ui.notify(
            "/branch-out is supported in tmux, Ghostty on macOS, or Ghostty on Linux.",
            "warning",
        );
        return;
    }

    const wasBusy = !ctx.isIdle();
    const parsed = parseArgs(args);
    const successfulSessions: string[] = [];
    const failedReasons: string[] = [];
    let launchedVia: LaunchTarget | undefined;

    for (let index = 0; index < parsed.count; index += 1) {
        const result = await launchOneFork(pi, ctx, launchTargets, parsed.prompt);
        if (result.launchedVia !== undefined) {
            launchedVia = result.launchedVia;
            if (result.sessionFile !== undefined) {
                successfulSessions.push(result.sessionFile);
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

    let targetDescription = "the selected launcher";
    if (launchedVia !== undefined) {
        targetDescription = describeLaunchTarget(launchedVia);
    }

    let forkWord = "forks";
    if (successfulSessions.length === 1) {
        forkWord = "fork";
    }

    ctx.ui.notify(
        `Opened ${successfulSessions.length} ${forkWord} in ${targetDescription}${promptSuffix}.`,
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
    const description =
        "Fork this session into one or more parallel Pi processes in tmux/Ghostty. Usage: /branch-out [count] [optional prompt]";

    pi.registerCommand("branch-out", {
        description,
        handler: async (args, ctx) => {
            await handleBranchOut(pi, args, ctx);
        },
    });

    pi.registerCommand("split-fork", {
        description: `${description} Alias for /branch-out.`,
        handler: async (args, ctx) => {
            await handleBranchOut(pi, args, ctx);
        },
    });
}
