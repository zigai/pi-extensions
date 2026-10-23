import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    discoverAndLoadExtensions,
    ExtensionRunner,
    ModelRegistry,
    ModelRuntime,
    SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
    BranchConfigFileSchema,
    CONFIG_SCHEMA_ID,
    gridColumnCount,
    parseTypedArgs,
    tmuxGridRowPaneCounts,
    tmuxRemainingRegionPercent,
} from "./index.ts";

describe("branch layouts", () => {
    it.each([
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 2],
        [5, 3],
        [6, 3],
        [9, 3],
        [10, 4],
    ])("uses a balanced column count for %i panes", (paneCount, expectedColumns) => {
        expect(gridColumnCount(paneCount)).toBe(expectedColumns);
    });

    it.each([
        [1, [1]],
        [4, [2, 2]],
        [5, [3, 2]],
        [6, [3, 3]],
        [7, [3, 2, 2]],
        [8, [3, 3, 2]],
        [10, [4, 3, 3]],
    ])("builds a balanced row-first grid for %i panes", (paneCount, expectedRows) => {
        expect(tmuxGridRowPaneCounts(paneCount)).toEqual(expectedRows);
    });

    it.each([
        [2, 50],
        [3, 67],
        [4, 75],
    ])("reserves the expected percentage for %i regions", (regionCount, expectedPercent) => {
        expect(tmuxRemainingRegionPercent(regionCount)).toBe(expectedPercent);
    });

    it.each([
        ["separate", "windows"],
        ["current-tab", "panes"],
        ["new-tab", "pane-window"],
    ] as const)("maps %s to %s launch mode", (layout, expectedMode) => {
        expect(
            parseTypedArgs({
                count: 3,
                layout,
                keepOpen: true,
                worktree: false,
                prompt: "compare approaches",
            }),
        ).toEqual({
            count: 3,
            mode: expectedMode,
            prompt: "compare approaches",
            keepOpen: true,
            worktree: false,
        });
    });
});

describe("branch prompts", () => {
    it.each(["--", "--no-session", "--unknown-option", "@", "@notes.txt"])(
        "sends %s to the child as a message rather than an option or attachment",
        async (prompt) => {
            const root = await mkdtemp(join(tmpdir(), "pi-branch-prompt-"));
            const originalArgv = process.argv.slice();
            try {
                const bin = join(root, "bin");
                const resultPath = join(root, "parsed.json");
                const childScript = join(root, "pi.mjs");
                await mkdir(bin);
                await writeFile(
                    childScript,
                    `import { parseArgs, discoverAndLoadExtensions, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))};
const args = parseArgs(process.argv.slice(2));
const loaded = await discoverAndLoadExtensions(args.extensions ?? [], process.cwd(), ${JSON.stringify(join(root, "agent"))});
if (loaded.errors.length > 0) throw new Error(JSON.stringify(loaded.errors));
const messages = [...args.messages];
loaded.runtime.sendUserMessage = (text) => messages.push(text);
const models = await ModelRuntime.create({ authPath: ${JSON.stringify(join(root, "auth.json"))}, modelsPath: null, refreshOnCreate: false });
const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, process.cwd(), SessionManager.inMemory(process.cwd()), new ModelRegistry(models));
for (const [name, value] of args.unknownFlags) runner.setFlagValue(name, value);
await runner.emit({ type: "session_start", reason: "startup" });
for (const reason of ["reload", "new", "resume", "fork"]) await runner.emit({ type: "session_start", reason });
process.stdout.write(JSON.stringify({ messages, fileArgs: args.fileArgs, noSession: args.noSession ?? false, unknownFlags: [...args.unknownFlags].filter(([name]) => !runner.getFlags().has(name)), diagnostics: args.diagnostics }));
`,
                );
                await writeFile(
                    join(bin, "tmux"),
                    `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst child = spawnSync('/bin/sh', ['-c', process.argv.at(-1)], { encoding: 'utf8' });\nif (child.status !== 0) { process.stderr.write(child.stderr); process.exit(1); }\nwriteFileSync(${JSON.stringify(resultPath)}, child.stdout);\nprocess.stdout.write('@1\\n');\n`,
                    { mode: 0o755 },
                );
                vi.stubEnv("PATH", bin);
                vi.stubEnv("TMUX", "isolated-launcher");
                vi.stubEnv("TMUX_PANE", undefined);
                process.argv[1] = childScript;
                const loaded = await discoverAndLoadExtensions(
                    [fileURLToPath(new URL("./index.ts", import.meta.url))],
                    root,
                    join(root, "agent"),
                );
                expect(loaded.errors).toEqual([]);
                const models = await ModelRuntime.create({
                    authPath: join(root, "auth.json"),
                    modelsPath: null,
                    refreshOnCreate: false,
                });
                const runner = new ExtensionRunner(
                    loaded.extensions,
                    loaded.runtime,
                    root,
                    SessionManager.inMemory(root),
                    new ModelRegistry(models),
                );
                const command = runner.getCommand("branch");
                if (command === undefined) throw new Error("Missing /branch command");

                await command.handler(
                    `--prompt ${JSON.stringify(prompt)}`,
                    runner.createCommandContext(),
                );

                const parsed: unknown = JSON.parse(await readFile(resultPath, "utf8"));
                expect(parsed).toEqual({
                    messages: [prompt],
                    fileArgs: [],
                    noSession: false,
                    unknownFlags: [],
                    diagnostics: [],
                });
            } finally {
                process.argv.splice(0, process.argv.length, ...originalArgv);
                vi.unstubAllEnvs();
                await rm(root, { recursive: true, force: true });
            }
        },
    );
});

async function loadBranchRunner(cwd: string, agentDir: string): Promise<ExtensionRunner> {
    const loaded = await discoverAndLoadExtensions(
        [fileURLToPath(new URL("./index.ts", import.meta.url))],
        cwd,
        agentDir,
    );
    expect(loaded.errors).toEqual([]);
    const models = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
    });

    return new ExtensionRunner(
        loaded.extensions,
        loaded.runtime,
        cwd,
        SessionManager.inMemory(cwd),
        new ModelRegistry(models),
    );
}

describe("branch worktrees", () => {
    it("forks the repository whose root ends in a space, not its trimmed sibling", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-branch-worktree-"));
        try {
            const agentDir = join(root, "agent");
            const source = join(root, "repo ");
            const sibling = join(root, "repo");
            const worktrees = join(root, "worktrees");
            const bin = join(root, "bin");
            await mkdir(bin);
            await mkdir(source);
            await mkdir(sibling);
            execFileSync("git", ["init", "--quiet", source]);
            execFileSync("git", ["init", "--quiet", sibling]);
            await writeFile(join(source, "origin.txt"), "source");
            await writeFile(join(sibling, "origin.txt"), "sibling");
            execFileSync("git", ["-C", source, "add", "origin.txt"]);
            execFileSync("git", ["-C", sibling, "add", "origin.txt"]);
            const commitArgs = [
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--quiet",
                "-m",
                "chore: initial",
            ];
            execFileSync("git", ["-C", source, ...commitArgs]);
            execFileSync("git", ["-C", sibling, ...commitArgs]);
            await writeFile(
                join(bin, "tmux"),
                `#!${process.execPath}\nprocess.stdout.write('@1\\n');\n`,
                { mode: 0o755 },
            );
            await mkdir(join(agentDir, "pi-branch"), { recursive: true });
            await writeFile(
                join(agentDir, "pi-branch", "config.json"),
                JSON.stringify({ worktreeDir: worktrees }),
            );
            vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
            vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
            vi.stubEnv("TMUX", "isolated-launcher");
            vi.stubEnv("TMUX_PANE", undefined);
            const runner = await loadBranchRunner(source, agentDir);
            const command = runner.getCommand("branch");
            if (command === undefined) throw new Error("Missing /branch command");

            await command.handler("--worktree", runner.createCommandContext());

            const directories = await readdir(worktrees);
            expect(directories).toHaveLength(1);
            const directory = directories.at(0);
            if (directory === undefined) throw new Error("No worktree was created");

            expect(await readFile(join(worktrees, directory, "origin.txt"), "utf8")).toBe("source");
        } finally {
            vi.unstubAllEnvs();
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe("branch configuration", () => {
    it("routes schema refresh failures through the session UI", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-branch-scaffold-"));
        const notices: string[] = [];
        let runner: ExtensionRunner | undefined;
        try {
            const agentDir = join(root, "agent");
            await mkdir(agentDir);
            await writeFile(join(agentDir, "pi-branch"), "keep");
            vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
            vi.stubEnv("TMUX", "isolated-launcher");
            runner = await loadBranchRunner(root, agentDir);
            runner.setUIContext(
                {
                    ...runner.getUIContext(),
                    notify: (message) => {
                        notices.push(message);
                    },
                },
                "rpc",
            );
            await runner.emit({ type: "session_start", reason: "startup" });
            const command = runner.getCommand("branch");
            if (command === undefined) throw new Error("Missing /branch command");

            await command.handler("--worktree", runner.createCommandContext());
            expect(
                notices.some((message) => message.startsWith("[pi-branch] Failed to refresh ")),
            ).toBe(true);

            expect(await readFile(join(agentDir, "pi-branch"), "utf8")).toBe("keep");
        } finally {
            await runner?.emit({ type: "session_shutdown", reason: "quit" });
            vi.unstubAllEnvs();
            await rm(root, { recursive: true, force: true });
        }
    });

    it("reports malformed config without quoting its contents", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-branch-config-"));
        try {
            const agentDir = join(root, "agent");
            const configPath = join(agentDir, "pi-branch", "config.json");
            await mkdir(join(configPath, ".."), { recursive: true });
            await writeFile(configPath, "private-token");
            vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
            vi.stubEnv("TMUX", "isolated-launcher");
            const runner = await loadBranchRunner(root, agentDir);
            const notifications: string[] = [];
            runner.setUIContext(
                {
                    ...runner.getUIContext(),
                    notify: (message) => {
                        notifications.push(message);
                    },
                },
                "rpc",
            );
            const command = runner.getCommand("branch");
            if (command === undefined) throw new Error("Missing /branch command");

            await command.handler("--worktree", runner.createCommandContext());

            expect(notifications).toEqual([
                `Invalid global pi-branch config at ${configPath}: Config must contain valid JSON.`,
            ]);

            expect(await readFile(configPath, "utf8")).toBe("private-token");
        } finally {
            vi.unstubAllEnvs();
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe("configuration schema", () => {
    it("matches the checked-in editor schema", () => {
        const actual: unknown = JSON.parse(readFileSync("config.schema.json", "utf8"));
        expect(actual).toEqual({
            $schema: "https://json-schema.org/draft/2020-12/schema",
            $id: CONFIG_SCHEMA_ID,
            ...BranchConfigFileSchema,
        });
    });
});
