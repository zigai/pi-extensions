/**
 * Pi Branch
 *
 * Adds `/branch` to fork the current Pi session into one or more parallel
 * Pi processes in tmux/Ghostty. Each child session starts from the current
 * committed branch state and can run in its own git worktree.
 */

import {
    CONFIG_DIR_NAME,
    getAgentDir,
    type ExtensionAPI,
    type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { defineTypedCommand, registerTypedCommand } from "pi-typed-args/command";
import { installTypedCommandUx } from "pi-typed-args/pi";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FORK_COUNT = 100;
const DEFAULT_WORKTREE_DIR_NAME = "worktrees";
const EXTENSION_ID = "pi-branch";
const CONFIG_FILE_NAME = "config.json";
const CONFIG_SCHEMA_FILE_NAME = "config.schema.json";
const CONFIG_SCHEMA_REFERENCE = "./config.schema.json";
export const CONFIG_SCHEMA_ID = "https://github.com/zigai/pi-branch/config.schema.json";

function createWorktreeDirSchema() {
    return Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
            default: DEFAULT_WORKTREE_DIR_NAME,
            description:
                "Directory for /branch --worktree. Null or an empty string disables worktrees.",
        }),
    );
}

const BranchConfigSchema = Type.Object(
    {
        worktreeDir: createWorktreeDirSchema(),
    },
    { additionalProperties: false },
);
type BranchConfig = Static<typeof BranchConfigSchema>;

export const BranchConfigFileSchema = Type.Object(
    {
        $schema: Type.Optional(
            Type.String({
                default: CONFIG_SCHEMA_REFERENCE,
                description: "Relative JSON Schema path for editors.",
            }),
        ),
        worktreeDir: createWorktreeDirSchema(),
    },
    { additionalProperties: false, description: "pi-branch extension configuration." },
);
type BranchConfigFile = Static<typeof BranchConfigFileSchema>;

const DEFAULT_BRANCH_CONFIG: BranchConfig = { worktreeDir: DEFAULT_WORKTREE_DIR_NAME };

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

type LaunchMode = "windows" | "panes" | "pane-window";
export type ForkLayout = "separate" | "current-tab" | "new-tab";
type LaunchTarget =
    | "tmux-window"
    | "tmux-current-panes"
    | "tmux-new-window-panes"
    | "ghostty-current-panes"
    | "ghostty-new-window-panes"
    | "ghostty-window";

export type ParsedArgs = {
    count: number;
    mode: LaunchMode;
    prompt: string;
    keepOpen: boolean;
    worktree: boolean;
};

export type BranchTypedArgs = {
    count: number;
    layout: ForkLayout;
    keepOpen: boolean;
    worktree: boolean;
    prompt?: string;
};

type SessionInfoEntry = {
    type: "session_info";
    id: string;
    parentId: string | null;
    timestamp: string;
    name: string;
};

type CommandResult = {
    code: number;
    stdout?: string;
    stderr?: string;
};

type LoadedBranchConfig = {
    config: BranchConfig;
    worktreeDirBaseDir?: string;
};

type BranchConfigResult =
    | LoadedBranchConfig
    | {
          error: string;
      };

type WorktreeConfig =
    | {
          enabled: false;
      }
    | {
          enabled: true;
          root: string;
      };

type WorktreeConfigResult =
    | WorktreeConfig
    | {
          enabled: false;
          error: string;
      };

type GitRepoInfo = {
    root: string;
    name: string;
};

type WorktreeInfo = {
    path: string;
    branch: string;
    cwd: string;
};

type PreparedFork = {
    name: string;
    cwd: string;
    sessionFile: string | undefined;
    worktree?: WorktreeInfo;
};

function runCommand(command: string, args: string[], cwd?: string): Promise<CommandResult> {
    return new Promise((resolve) => {
        execFile(command, args, { encoding: "utf8", cwd }, (error, stdout, stderr) => {
            let code = 0;
            if (error !== null) {
                code = 1;
                if (typeof error.code === "number") {
                    code = error.code;
                }
            }
            resolve({ code, stdout, stderr });
        });
    });
}

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
            targets.push("tmux-current-panes");
        } else if (mode === "pane-window") {
            targets.push("tmux-new-window-panes");
        } else {
            targets.push("tmux-window");
        }
    }

    if (process.platform === "darwin") {
        if (mode === "panes") {
            targets.push("ghostty-current-panes");
        } else if (mode === "pane-window") {
            targets.push("ghostty-new-window-panes");
        } else {
            targets.push("ghostty-window");
        }
    } else if (process.platform === "linux" && mode === "windows") {
        targets.push("ghostty-window");
    }

    return targets;
}

function describeLaunchTarget(target: LaunchTarget): string {
    switch (target) {
        case "tmux-window":
            return "a new tmux window";
        case "tmux-current-panes":
            return "tmux panes in the current window";
        case "tmux-new-window-panes":
            return "one new tmux window split into panes";
        case "ghostty-current-panes":
            return "Ghostty splits in the current window";
        case "ghostty-new-window-panes":
            return "one new Ghostty window split into panes";
        case "ghostty-window":
            return "a new Ghostty window";
    }
}

async function getCurrentTmuxWindowTarget(): Promise<string | undefined> {
    const targetPane = process.env.TMUX_PANE?.trim();
    if (targetPane === undefined || targetPane.length === 0) {
        return undefined;
    }

    try {
        const result = await runCommand("tmux", [
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

function expandHomePath(value: string): string {
    if (value === "~") {
        return homedir();
    }

    if (value.startsWith("~/")) {
        return path.join(homedir(), value.slice(2));
    }

    return value;
}

function resolveSettingPath(value: string, baseDir: string): string {
    const expanded = expandHomePath(value);
    if (path.isAbsolute(expanded)) {
        return path.resolve(expanded);
    }

    return path.resolve(baseDir, expanded);
}

function getDefaultWorktreeRoot(): string {
    return path.join(getAgentDir(), DEFAULT_WORKTREE_DIR_NAME);
}

function getGlobalBranchConfigDir(): string {
    return path.join(getAgentDir(), EXTENSION_ID);
}

function isFileAlreadyPresentError(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"
    );
}

function isFileMissingError(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
}

function getDefaultBranchConfigFileText(): string {
    return `${JSON.stringify({ $schema: CONFIG_SCHEMA_REFERENCE, ...DEFAULT_BRANCH_CONFIG }, null, 2)}\n`;
}

async function readInstalledBranchConfigSchemaText(): Promise<string | undefined> {
    const installedSchemaPath = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        CONFIG_SCHEMA_FILE_NAME,
    );
    try {
        return await fs.readFile(installedSchemaPath, "utf8");
    } catch (error: unknown) {
        console.error(
            `[pi-branch] Failed to read installed schema ${installedSchemaPath}: ${formatUnknownError(error)}`,
        );
        return undefined;
    }
}

async function writeTextFileIfMissing(filePath: string, content: string): Promise<void> {
    try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
    } catch (error: unknown) {
        if (isFileAlreadyPresentError(error)) {
            return;
        }
        console.error(`[pi-branch] Failed to scaffold ${filePath}: ${formatUnknownError(error)}`);
    }
}

async function refreshExtensionOwnedTextFile(filePath: string, content: string): Promise<void> {
    try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        try {
            if ((await fs.readFile(filePath, "utf8")) === content) {
                return;
            }
        } catch (error: unknown) {
            if (!isFileMissingError(error)) {
                console.error(
                    `[pi-branch] Failed to read ${filePath}: ${formatUnknownError(error)}`,
                );
            }
        }
        await fs.writeFile(filePath, content, "utf8");
    } catch (error: unknown) {
        console.error(`[pi-branch] Failed to refresh ${filePath}: ${formatUnknownError(error)}`);
    }
}

async function scaffoldGlobalBranchConfigFiles(): Promise<void> {
    const globalConfigDir = getGlobalBranchConfigDir();
    await writeTextFileIfMissing(
        path.join(globalConfigDir, CONFIG_FILE_NAME),
        getDefaultBranchConfigFileText(),
    );

    const installedSchemaText = await readInstalledBranchConfigSchemaText();
    if (installedSchemaText !== undefined) {
        await refreshExtensionOwnedTextFile(
            path.join(globalConfigDir, CONFIG_SCHEMA_FILE_NAME),
            installedSchemaText,
        );
    }
}

function parseBranchConfig(parsed: unknown): BranchConfigFile {
    if (!Value.Check(BranchConfigFileSchema, parsed)) {
        throw new Error("Config does not match config.schema.json");
    }

    return Value.Decode(BranchConfigFileSchema, parsed);
}

function projectBranchConfig(fileConfig: BranchConfigFile): BranchConfig {
    if (fileConfig.worktreeDir === undefined) {
        return {};
    }

    return { worktreeDir: fileConfig.worktreeDir };
}

function getBranchConfigPaths(ctx: ExtensionCommandContext): Array<{
    file: string;
    baseDir: string;
    label: string;
}> {
    const agentDir = getAgentDir();
    const projectConfigDir = path.join(ctx.cwd, CONFIG_DIR_NAME);
    return [
        {
            file: path.join(agentDir, EXTENSION_ID, CONFIG_FILE_NAME),
            baseDir: agentDir,
            label: "global",
        },
        {
            file: path.join(projectConfigDir, EXTENSION_ID, CONFIG_FILE_NAME),
            baseDir: projectConfigDir,
            label: "project",
        },
    ];
}

async function readBranchConfigFile(input: {
    file: string;
    baseDir: string;
    label: string;
}): Promise<
    | {
          state: "missing";
      }
    | {
          state: "loaded";
          config: BranchConfigFile;
          hasWorktreeDir: boolean;
          baseDir: string;
      }
    | {
          state: "invalid";
          error: string;
      }
> {
    if (!existsSync(input.file)) {
        return { state: "missing" };
    }

    try {
        const parsed: unknown = JSON.parse(await fs.readFile(input.file, "utf8"));
        const hasWorktreeDir =
            typeof parsed === "object" && parsed !== null && Object.hasOwn(parsed, "worktreeDir");
        const config = parseBranchConfig(parsed);
        return {
            state: "loaded",
            config,
            hasWorktreeDir,
            baseDir: input.baseDir,
        };
    } catch (error: unknown) {
        return {
            state: "invalid",
            error: `Invalid ${input.label} pi-branch config at ${input.file}: ${formatUnknownError(error)}`,
        };
    }
}

async function loadBranchConfig(ctx: ExtensionCommandContext): Promise<BranchConfigResult> {
    await scaffoldGlobalBranchConfigFiles();

    const config: BranchConfig = { ...DEFAULT_BRANCH_CONFIG };
    let worktreeDirBaseDir: string | undefined = getAgentDir();

    for (const configPath of getBranchConfigPaths(ctx)) {
        const result = await readBranchConfigFile(configPath);
        if (result.state === "missing") {
            continue;
        }

        if (result.state === "invalid") {
            return { error: result.error };
        }

        Object.assign(config, projectBranchConfig(result.config));
        if (result.hasWorktreeDir) {
            worktreeDirBaseDir = result.baseDir;
        }
    }

    if (worktreeDirBaseDir !== undefined) {
        return { config, worktreeDirBaseDir };
    }

    return { config };
}

async function getConfigWorktreeConfig(
    ctx: ExtensionCommandContext,
): Promise<WorktreeConfigResult> {
    const result = await loadBranchConfig(ctx);
    if ("error" in result) {
        return { enabled: false, error: result.error };
    }

    const rawValue = result.config.worktreeDir;
    if (rawValue === undefined) {
        return { enabled: true, root: getDefaultWorktreeRoot() };
    }

    if (rawValue === null) {
        return {
            enabled: false,
            error: `pi-branch worktreeDir is null. Remove it to use ${getDefaultWorktreeRoot()}, or set it to a directory path.`,
        };
    }

    const trimmedValue = rawValue.trim();
    if (trimmedValue.length === 0) {
        return {
            enabled: false,
            error: `pi-branch worktreeDir is empty. Remove it to use ${getDefaultWorktreeRoot()}, or set it to a directory path.`,
        };
    }

    return {
        enabled: true,
        root: resolveSettingPath(trimmedValue, result.worktreeDirBaseDir ?? getAgentDir()),
    };
}

async function getWorktreeConfig(
    ctx: ExtensionCommandContext,
    parsed: ParsedArgs,
): Promise<WorktreeConfigResult> {
    if (!parsed.worktree) {
        return { enabled: false };
    }

    return getConfigWorktreeConfig(ctx);
}

function slugify(value: string, fallback: string, maxLength = 48): string {
    const slug = value
        .trim()
        .replaceAll(/[^A-Za-z0-9]+/g, "-")
        .replaceAll(/^-+|-+$/g, "")
        .slice(0, maxLength)
        .replaceAll(/^-+|-+$/g, "");

    if (slug.length === 0) {
        return fallback;
    }

    return slug;
}

async function pathIsDirectory(value: string): Promise<boolean> {
    try {
        const stat = await fs.stat(value);
        return stat.isDirectory();
    } catch {
        return false;
    }
}

async function getGitRepoInfo(cwd: string): Promise<GitRepoInfo> {
    const rootResult = await runCommand("git", ["rev-parse", "--show-toplevel"], cwd);
    if (rootResult.code !== 0) {
        throw new Error(
            `Cannot create worktree outside a git repository: ${formatExecFailure(rootResult)}`,
        );
    }

    const root = rootResult.stdout?.trim();
    if (root === undefined || root.length === 0) {
        throw new Error("Cannot create worktree because git did not report a repository root.");
    }

    const headResult = await runCommand("git", ["rev-parse", "--verify", "HEAD"], root);
    if (headResult.code !== 0) {
        throw new Error(
            `Cannot create worktree because HEAD is unavailable: ${formatExecFailure(headResult)}`,
        );
    }

    return {
        root,
        name: path.basename(root) || "repo",
    };
}

function getMirroredWorktreeCwd(repoRoot: string, sourceCwd: string, worktreePath: string): string {
    const relativeCwd = path.relative(repoRoot, sourceCwd);
    if (relativeCwd.length === 0 || relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
        return worktreePath;
    }

    return path.join(worktreePath, relativeCwd);
}

async function createForkWorktree(
    worktreeRoot: string,
    repoInfo: GitRepoInfo,
    sourceCwd: string,
    launchName: string,
): Promise<WorktreeInfo> {
    await fs.mkdir(worktreeRoot, { recursive: true });

    const id = randomUUID().replaceAll("-", "").slice(0, 8);
    const repoSlug = slugify(repoInfo.name, "repo");
    const launchSlug = slugify(launchName, "fork");
    const branch = `pi-branch/${launchSlug}-${id}`;
    const worktreePath = path.join(worktreeRoot, `${repoSlug}-${launchSlug}-${id}`);
    const result = await runCommand(
        "git",
        ["worktree", "add", "-b", branch, worktreePath, "HEAD"],
        repoInfo.root,
    );

    if (result.code !== 0) {
        throw new Error(`git worktree add failed: ${formatExecFailure(result)}`);
    }

    const mirroredCwd = getMirroredWorktreeCwd(repoInfo.root, sourceCwd, worktreePath);
    let cwd = worktreePath;
    if (await pathIsDirectory(mirroredCwd)) {
        cwd = mirroredCwd;
    }

    return { path: worktreePath, branch, cwd };
}

export function parseTypedArgs(args: BranchTypedArgs): ParsedArgs {
    let mode: LaunchMode = "windows";
    if (args.layout === "current-tab") {
        mode = "panes";
    } else if (args.layout === "new-tab") {
        mode = "pane-window";
    }

    return {
        count: args.count,
        mode,
        prompt: args.prompt ?? "",
        keepOpen: args.keepOpen,
        worktree: args.worktree,
    };
}

function buildForkName(baseName: string, index: number): string {
    const branchNumber = index + 1;
    return `${baseName} ${branchNumber}`;
}

function getBaseSessionName(ctx: ExtensionCommandContext): string {
    const sessionName = ctx.sessionManager.getSessionName();
    if (sessionName !== undefined && sessionName.trim().length > 0) {
        return sessionName.trim();
    }

    return path.basename(ctx.cwd) || "Pi session";
}

async function createForkedSession(
    ctx: ExtensionCommandContext,
    sessionName: string,
    targetCwd?: string,
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

    let cwd = targetCwd ?? ctx.cwd;
    if (targetCwd === undefined && currentHeader?.cwd !== undefined) {
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
    target: LaunchTarget,
    ctx: ExtensionCommandContext,
    sessionFile: string | undefined,
    prompt: string,
    keepOpen: boolean,
    launchName: string,
    launchCwd: string,
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
                launchCwd,
                buildPiShellCommand(sessionFile, prompt, modelArg, keepOpen),
            );
            return runCommand("tmux", tmuxArgs);
        }
        case "ghostty-window":
            if (process.platform === "darwin") {
                return runCommand("osascript", [
                    "-e",
                    GHOSTTY_WINDOW_SCRIPT,
                    "--",
                    launchCwd,
                    buildPiStartupInput(sessionFile, prompt, modelArg, keepOpen),
                ]);
            }

            if (keepOpen) {
                return runCommand("ghostty", [
                    "+new-window",
                    `--working-directory=${launchCwd}`,
                    "-e",
                    "/bin/sh",
                    "-c",
                    buildPiShellCommand(sessionFile, prompt, modelArg, keepOpen),
                ]);
            }

            return runCommand("ghostty", [
                "+new-window",
                `--working-directory=${launchCwd}`,
                "-e",
                ...buildPiCommandParts(sessionFile, prompt, modelArg),
            ]);
        case "tmux-current-panes":
        case "tmux-new-window-panes":
        case "ghostty-current-panes":
        case "ghostty-new-window-panes":
            return {
                code: 1,
                stderr: `${describeLaunchTarget(target)} requires grouped pane launch`,
            };
    }
}

function tmuxLayoutForPaneCount(paneCount: number): string | undefined {
    if (paneCount <= 1) {
        return undefined;
    }

    if (paneCount <= 3) {
        return "even-horizontal";
    }

    return "tiled";
}

async function getTmuxPaneCount(targetWindow: string): Promise<number | undefined> {
    const result = await runCommand("tmux", ["list-panes", "-t", targetWindow, "-F", "#{pane_id}"]);
    if (result.code !== 0) {
        return undefined;
    }

    const output = result.stdout?.trim();
    if (output === undefined || output.length === 0) {
        return undefined;
    }

    return output.split("\n").length;
}

async function applySmartTmuxLayout(targetWindow: string, paneCount?: number): Promise<void> {
    const resolvedPaneCount = paneCount ?? (await getTmuxPaneCount(targetWindow));
    if (resolvedPaneCount === undefined) {
        return;
    }

    const layout = tmuxLayoutForPaneCount(resolvedPaneCount);
    if (layout === undefined) {
        return;
    }

    await runCommand("tmux", ["select-layout", "-t", targetWindow, layout]);
}

function parseTmuxWindowAndPaneId(stdout: string | undefined):
    | {
          windowId: string;
          paneId: string;
      }
    | undefined {
    const output = stdout?.trim();
    if (output === undefined || output.length === 0) {
        return undefined;
    }

    const [windowId, paneId] = output.split(/\s+/);
    if (windowId === undefined || paneId === undefined) {
        return undefined;
    }

    return { windowId, paneId };
}

export function gridColumnCount(totalPanes: number): number {
    if (totalPanes <= 3) {
        return totalPanes;
    }

    return Math.ceil(Math.sqrt(totalPanes));
}

export function tmuxRemainingRegionPercent(regionCount: number): number {
    return Math.round(((regionCount - 1) / regionCount) * 100);
}

export function tmuxGridRowPaneCounts(paneCount: number): number[] {
    const columnCount = gridColumnCount(paneCount);
    const rowCount = Math.ceil(paneCount / columnCount);
    const minimumPanesPerRow = Math.floor(paneCount / rowCount);
    const rowsWithExtraPane = paneCount % rowCount;
    return Array.from({ length: rowCount }, (_, rowIndex) => {
        if (rowIndex < rowsWithExtraPane) {
            return minimumPanesPerRow + 1;
        }
        return minimumPanesPerRow;
    });
}

async function launchTmuxCurrentPaneGroup(
    forks: PreparedFork[],
    prompt: string,
    modelArg: string | undefined,
    keepOpen: boolean,
): Promise<CommandResult> {
    const targetPane = process.env.TMUX_PANE?.trim();
    if (targetPane === undefined || targetPane.length === 0) {
        return { code: 1, stderr: "Current tmux pane is unknown." };
    }

    const targetWindow = await getCurrentTmuxWindowTarget();
    for (const fork of forks) {
        const result = await runCommand("tmux", [
            "split-window",
            "-h",
            "-d",
            "-P",
            "-F",
            "#{pane_id}",
            "-t",
            targetPane,
            "-c",
            fork.cwd,
            buildPiShellCommand(fork.sessionFile, prompt, modelArg, keepOpen),
        ]);
        if (result.code !== 0) {
            return result;
        }
    }

    if (targetWindow !== undefined) {
        await applySmartTmuxLayout(targetWindow);
    }

    return { code: 0, stdout: targetWindow };
}

async function launchTmuxNewWindowPaneGroup(
    forks: PreparedFork[],
    prompt: string,
    modelArg: string | undefined,
    keepOpen: boolean,
    launchName: string,
    tmuxWindowTarget: string | undefined,
): Promise<CommandResult> {
    const [firstFork] = forks;
    if (firstFork === undefined) {
        return { code: 1, stderr: "No forks to launch." };
    }

    const tmuxArgs = ["new-window", "-a", "-P", "-F", "#{window_id} #{pane_id}"];
    if (tmuxWindowTarget !== undefined) {
        tmuxArgs.push("-t", tmuxWindowTarget);
    }
    tmuxArgs.push(
        "-n",
        launchName,
        "-c",
        firstFork.cwd,
        buildPiShellCommand(firstFork.sessionFile, prompt, modelArg, keepOpen),
    );

    const windowResult = await runCommand("tmux", tmuxArgs);
    if (windowResult.code !== 0) {
        return windowResult;
    }

    const ids = parseTmuxWindowAndPaneId(windowResult.stdout);
    if (ids === undefined) {
        return { code: 1, stderr: "tmux did not report the created window and pane ids." };
    }

    const rowPaneCounts = tmuxGridRowPaneCounts(forks.length);
    const rowStartIndexes: number[] = [];
    let nextRowStartIndex = 0;
    for (const rowPaneCount of rowPaneCounts) {
        rowStartIndexes.push(nextRowStartIndex);
        nextRowStartIndex += rowPaneCount;
    }

    const rowAnchorPaneIds = [ids.paneId];
    let remainingRowsPaneId = ids.paneId;
    for (let rowIndex = 1; rowIndex < rowPaneCounts.length; rowIndex += 1) {
        const forkIndex = rowStartIndexes[rowIndex];
        if (forkIndex === undefined) {
            return { code: 1, stderr: "Could not assign a fork to a tmux grid row." };
        }
        const fork = forks[forkIndex];
        if (fork === undefined) {
            return { code: 1, stderr: "Could not find the fork assigned to a tmux grid row." };
        }
        const remainingRowCount = rowPaneCounts.length - rowIndex + 1;
        const result = await runCommand("tmux", [
            "split-window",
            "-v",
            "-d",
            "-P",
            "-F",
            "#{pane_id}",
            "-l",
            `${tmuxRemainingRegionPercent(remainingRowCount)}%`,
            "-t",
            remainingRowsPaneId,
            "-c",
            fork.cwd,
            buildPiShellCommand(fork.sessionFile, prompt, modelArg, keepOpen),
        ]);
        if (result.code !== 0) {
            return result;
        }
        const paneId = result.stdout?.trim();
        if (paneId === undefined || paneId.length === 0) {
            return { code: 1, stderr: "tmux did not report the created row pane id." };
        }
        rowAnchorPaneIds.push(paneId);
        remainingRowsPaneId = paneId;
    }

    for (let rowIndex = 0; rowIndex < rowPaneCounts.length; rowIndex += 1) {
        const rowPaneCount = rowPaneCounts[rowIndex];
        const rowStartIndex = rowStartIndexes[rowIndex];
        const rowAnchorPaneId = rowAnchorPaneIds[rowIndex];
        if (
            rowPaneCount === undefined ||
            rowStartIndex === undefined ||
            rowAnchorPaneId === undefined
        ) {
            return { code: 1, stderr: "Could not construct the tmux grid row." };
        }

        let remainingColumnsPaneId = rowAnchorPaneId;
        for (let columnIndex = 1; columnIndex < rowPaneCount; columnIndex += 1) {
            const fork = forks[rowStartIndex + columnIndex];
            if (fork === undefined) {
                return {
                    code: 1,
                    stderr: "Could not find the fork assigned to a tmux grid column.",
                };
            }
            const remainingColumnCount = rowPaneCount - columnIndex + 1;
            const result = await runCommand("tmux", [
                "split-window",
                "-h",
                "-d",
                "-P",
                "-F",
                "#{pane_id}",
                "-l",
                `${tmuxRemainingRegionPercent(remainingColumnCount)}%`,
                "-t",
                remainingColumnsPaneId,
                "-c",
                fork.cwd,
                buildPiShellCommand(fork.sessionFile, prompt, modelArg, keepOpen),
            ]);
            if (result.code !== 0) {
                return result;
            }
            const paneId = result.stdout?.trim();
            if (paneId === undefined || paneId.length === 0) {
                return { code: 1, stderr: "tmux did not report the created column pane id." };
            }
            remainingColumnsPaneId = paneId;
        }
    }

    return { code: 0, stdout: ids.windowId };
}

function buildGhosttyConfigScript(configCount: number): string {
    const lines: string[] = [];
    for (let index = 1; index <= configCount; index += 1) {
        const cwdArg = (index - 1) * 2 + 1;
        const inputArg = cwdArg + 1;
        lines.push(
            `set cfg${index} to new surface configuration`,
            `set initial working directory of cfg${index} to item ${cwdArg} of argv`,
            `set initial input of cfg${index} to item ${inputArg} of argv`,
        );
    }

    return lines.map((line) => `\t\t${line}`).join("\n");
}

function buildGhosttySplitScript(options: {
    mode: "current" | "new-window";
    forkCount: number;
}): string {
    let totalPanes = options.forkCount;
    if (options.mode === "current") {
        totalPanes = options.forkCount + 1;
    }
    const columns = gridColumnCount(totalPanes);
    const splitLines: string[] = [];

    let nextConfigIndex = 2;
    if (options.mode === "current") {
        nextConfigIndex = 1;
    }
    for (let cell = 1; cell < columns && nextConfigIndex <= options.forkCount; cell += 1) {
        splitLines.push(
            `set term${cell} to split term${cell - 1} direction right with configuration cfg${nextConfigIndex}`,
        );
        nextConfigIndex += 1;
    }

    let rowStart = columns;
    while (nextConfigIndex <= options.forkCount) {
        for (
            let column = 0;
            column < columns && nextConfigIndex <= options.forkCount;
            column += 1
        ) {
            const sourceCell = rowStart - columns + column;
            const targetCell = rowStart + column;
            splitLines.push(
                `set term${targetCell} to split term${sourceCell} direction down with configuration cfg${nextConfigIndex}`,
            );
            nextConfigIndex += 1;
        }
        rowStart += columns;
    }

    const setupLines: string[] = [];
    if (options.mode === "new-window") {
        setupLines.push(
            "new window with configuration cfg1",
            "set frontWindow to front window",
            "set term0 to focused terminal of selected tab of frontWindow",
        );
    } else {
        setupLines.push(
            "set frontWindow to front window",
            "set term0 to focused terminal of selected tab of frontWindow",
        );
    }

    return `on run argv
\ttell application "Ghostty"
${buildGhosttyConfigScript(options.forkCount)}
\t\t${setupLines.join("\n\t\t")}
\t\t${splitLines.join("\n\t\t")}
\t\tactivate
\tend tell
end run`;
}

function buildGhosttyPaneArgs(
    forks: PreparedFork[],
    prompt: string,
    modelArg: string | undefined,
    keepOpen: boolean,
): string[] {
    return forks.flatMap((fork) => [
        fork.cwd,
        buildPiStartupInput(fork.sessionFile, prompt, modelArg, keepOpen),
    ]);
}

function launchGhosttyPaneGroup(
    target: "ghostty-current-panes" | "ghostty-new-window-panes",
    forks: PreparedFork[],
    prompt: string,
    modelArg: string | undefined,
    keepOpen: boolean,
): Promise<CommandResult> {
    let mode: "current" | "new-window" = "new-window";
    if (target === "ghostty-current-panes") {
        mode = "current";
    }
    return runCommand("osascript", [
        "-e",
        buildGhosttySplitScript({ mode, forkCount: forks.length }),
        "--",
        ...buildGhosttyPaneArgs(forks, prompt, modelArg, keepOpen),
    ]);
}

async function launchForkedPiGroup(
    target: LaunchTarget,
    ctx: ExtensionCommandContext,
    forks: PreparedFork[],
    prompt: string,
    keepOpen: boolean,
    launchName: string,
    tmuxWindowTarget: string | undefined,
): Promise<CommandResult> {
    const modelArg = currentModelArg(ctx);

    switch (target) {
        case "tmux-current-panes":
            return launchTmuxCurrentPaneGroup(forks, prompt, modelArg, keepOpen);
        case "tmux-new-window-panes":
            return launchTmuxNewWindowPaneGroup(
                forks,
                prompt,
                modelArg,
                keepOpen,
                launchName,
                tmuxWindowTarget,
            );
        case "ghostty-current-panes":
        case "ghostty-new-window-panes":
            return launchGhosttyPaneGroup(target, forks, prompt, modelArg, keepOpen);
        case "tmux-window":
        case "ghostty-window":
            return { code: 1, stderr: `${describeLaunchTarget(target)} is not a pane group.` };
    }
}

async function launchForkGroup(
    ctx: ExtensionCommandContext,
    launchTargets: LaunchTarget[],
    forks: PreparedFork[],
    prompt: string,
    keepOpen: boolean,
    launchName: string,
    tmuxWindowTarget: string | undefined,
): Promise<{
    launchedVia?: LaunchTarget;
    failures: string[];
    tmuxWindowId?: string;
}> {
    const failures: string[] = [];

    for (const target of launchTargets) {
        try {
            const result = await launchForkedPiGroup(
                target,
                ctx,
                forks,
                prompt,
                keepOpen,
                launchName,
                tmuxWindowTarget,
            );
            if (result.code === 0) {
                let tmuxWindowId: string | undefined;
                if (target === "tmux-new-window-panes") {
                    tmuxWindowId = parseTmuxWindowId(result.stdout);
                }

                return { launchedVia: target, failures, tmuxWindowId };
            }

            failures.push(`${describeLaunchTarget(target)}: ${formatExecFailure(result)}`);
        } catch (error) {
            failures.push(`${describeLaunchTarget(target)}: ${formatUnknownError(error)}`);
        }
    }

    return { failures };
}

async function launchOneFork(
    ctx: ExtensionCommandContext,
    launchTargets: LaunchTarget[],
    prompt: string,
    keepOpen: boolean,
    launchName: string,
    launchCwd: string,
    sessionCwd: string | undefined,
    tmuxWindowTarget: string | undefined,
): Promise<{
    launchedVia?: LaunchTarget;
    sessionFile?: string;
    failures: string[];
    tmuxWindowId?: string;
}> {
    const forkedSessionFile = await createForkedSession(ctx, launchName, sessionCwd);
    const failures: string[] = [];

    for (const target of launchTargets) {
        try {
            const result = await launchForkedPi(
                target,
                ctx,
                forkedSessionFile,
                prompt,
                keepOpen,
                launchName,
                launchCwd,
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

async function prepareFork(
    ctx: ExtensionCommandContext,
    launchName: string,
    worktreeRoot: string | undefined,
    gitRepoInfo: GitRepoInfo | undefined,
): Promise<PreparedFork> {
    let launchCwd = ctx.cwd;
    let sessionCwd: string | undefined;
    let worktreeInfo: WorktreeInfo | undefined;

    if (worktreeRoot !== undefined && gitRepoInfo !== undefined) {
        worktreeInfo = await createForkWorktree(worktreeRoot, gitRepoInfo, ctx.cwd, launchName);
        launchCwd = worktreeInfo.cwd;
        sessionCwd = worktreeInfo.cwd;
    }

    const sessionFile = await createForkedSession(ctx, launchName, sessionCwd);
    const fork: PreparedFork = {
        name: launchName,
        cwd: launchCwd,
        sessionFile,
    };
    if (worktreeInfo !== undefined) {
        fork.worktree = worktreeInfo;
    }

    return fork;
}

async function handleParsedBranch(parsed: ParsedArgs, ctx: ExtensionCommandContext): Promise<void> {
    const launchTargets = getLaunchTargets(parsed.mode);
    if (launchTargets.length === 0) {
        let message = "/branch is supported in tmux, Ghostty on macOS, or Ghostty on Linux.";
        if (parsed.mode !== "windows") {
            message = "Pane modes require tmux or Ghostty on macOS.";
        }
        ctx.ui.notify(message, "warning");
        return;
    }

    const worktreeConfig = await getWorktreeConfig(ctx, parsed);
    if ("error" in worktreeConfig) {
        ctx.ui.notify(worktreeConfig.error, "error");
        return;
    }

    let worktreeRoot: string | undefined;
    if (worktreeConfig.enabled) {
        worktreeRoot = worktreeConfig.root;
    }
    let gitRepoInfo: GitRepoInfo | undefined;
    if (worktreeRoot !== undefined) {
        try {
            gitRepoInfo = await getGitRepoInfo(ctx.cwd);
        } catch (error) {
            ctx.ui.notify(formatUnknownError(error), "error");
            return;
        }
    }

    const wasBusy = !ctx.isIdle();
    const baseSessionName = getBaseSessionName(ctx);
    let successfulLaunches = 0;
    const successfulWorktrees: WorktreeInfo[] = [];
    const failedReasons: string[] = [];
    let launchedVia: LaunchTarget | undefined;
    let tmuxWindowTarget: string | undefined;
    if (launchTargets.includes("tmux-window") || launchTargets.includes("tmux-new-window-panes")) {
        tmuxWindowTarget = await getCurrentTmuxWindowTarget();
    }

    if (parsed.mode !== "windows") {
        const forks: PreparedFork[] = [];
        for (let index = 0; index < parsed.count; index += 1) {
            const launchName = buildForkName(baseSessionName, index);
            try {
                const fork = await prepareFork(ctx, launchName, worktreeRoot, gitRepoInfo);
                forks.push(fork);
                if (fork.worktree !== undefined) {
                    successfulWorktrees.push(fork.worktree);
                }
            } catch (error) {
                failedReasons.push(`${launchName}: ${formatUnknownError(error)}`);
            }
        }

        if (forks.length === 0) {
            ctx.ui.notify(`Failed to prepare forked session: ${failedReasons.join("; ")}`, "error");
            return;
        }

        const result = await launchForkGroup(
            ctx,
            launchTargets,
            forks,
            parsed.prompt,
            parsed.keepOpen,
            baseSessionName,
            tmuxWindowTarget,
        );
        if (result.launchedVia === undefined) {
            const reason = result.failures.join("; ") || "no supported launcher available";
            failedReasons.push(reason);
            for (const fork of forks) {
                if (fork.sessionFile !== undefined) {
                    ctx.ui.notify(`Forked session was created: ${fork.sessionFile}`, "info");
                }
                if (fork.worktree !== undefined) {
                    ctx.ui.notify(
                        `Worktree was created: ${fork.worktree.path} (${fork.worktree.branch})`,
                        "info",
                    );
                }
            }
            ctx.ui.notify(`Failed to launch forked session: ${failedReasons.join("; ")}`, "error");
            return;
        }

        launchedVia = result.launchedVia;
        successfulLaunches = forks.length;
    } else {
        for (let index = 0; index < parsed.count; index += 1) {
            const launchName = buildForkName(baseSessionName, index);
            let launchCwd = ctx.cwd;
            let sessionCwd: string | undefined;
            let worktreeInfo: WorktreeInfo | undefined;

            if (worktreeRoot !== undefined && gitRepoInfo !== undefined) {
                try {
                    worktreeInfo = await createForkWorktree(
                        worktreeRoot,
                        gitRepoInfo,
                        ctx.cwd,
                        launchName,
                    );
                    launchCwd = worktreeInfo.cwd;
                    sessionCwd = worktreeInfo.cwd;
                } catch (error) {
                    failedReasons.push(`${launchName}: ${formatUnknownError(error)}`);
                    continue;
                }
            }

            const result = await launchOneFork(
                ctx,
                launchTargets,
                parsed.prompt,
                parsed.keepOpen,
                launchName,
                launchCwd,
                sessionCwd,
                tmuxWindowTarget,
            );
            if (result.launchedVia !== undefined) {
                launchedVia = result.launchedVia;
                successfulLaunches += 1;
                if (worktreeInfo !== undefined) {
                    successfulWorktrees.push(worktreeInfo);
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
                if (worktreeInfo !== undefined) {
                    ctx.ui.notify(
                        `Worktree was created: ${worktreeInfo.path} (${worktreeInfo.branch})`,
                        "info",
                    );
                }
            }
        }
    }

    if (successfulLaunches === 0) {
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
    if (successfulLaunches === 1) {
        forkWord = "fork";
    }

    let worktreeSuffix = "";
    if (worktreeRoot !== undefined) {
        worktreeSuffix = ` using git worktrees in ${worktreeRoot}`;
    }

    ctx.ui.notify(
        `Opened ${successfulLaunches} ${forkWord} in ${targetDescription}${promptSuffix}${keepOpenSuffix}${worktreeSuffix}.`,
        "info",
    );

    if (successfulWorktrees.length === 1) {
        const [worktree] = successfulWorktrees;
        ctx.ui.notify(`Created worktree: ${worktree.path} (${worktree.branch})`, "info");
    }

    if (parsed.count > successfulLaunches) {
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

function createBranchCommand() {
    return defineTypedCommand({
        name: "branch",
        description: "Fork this session into one or more parallel Pi processes",
        formTitle: "/branch",
        args: {
            count: {
                type: "number",
                integer: true,
                position: 0,
                min: 1,
                max: MAX_FORK_COUNT,
                default: 1,
                title: "Count",
                description: "Number of forks to create",
            },
            layout: {
                type: "enum",
                values: ["separate", "current-tab", "new-tab"],
                default: "separate",
                title: "Where to open forks",
                optionDescriptions: {
                    separate: "One tab/window per fork",
                    "current-tab": "Add panes beside this Pi",
                    "new-tab": "Put all forks in one split tab/window",
                },
                ui: {
                    widget: "radio",
                },
            },
            keepOpen: {
                type: "boolean",
                default: false,
                title: "Keep open",
                description: "Keep the terminal shell open after Pi exits",
            },
            worktree: {
                type: "boolean",
                default: false,
                title: "Worktree",
                description: "Open forks in git worktrees",
            },
            prompt: {
                type: "string",
                title: "Prompt",
                description: "Optional initial prompt sent to each fork",
                placeholder: "prompt",
                ui: {
                    widget: "textarea",
                    rows: 5,
                },
            },
        },
        run: async (args, ctx) => {
            await handleParsedBranch(parseTypedArgs(args), ctx);
        },
    });
}

export default function (pi: ExtensionAPI): void {
    installTypedCommandUx(pi);
    registerTypedCommand(pi, createBranchCommand());
}
