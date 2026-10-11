import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
