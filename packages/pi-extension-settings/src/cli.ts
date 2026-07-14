import { resolve } from "node:path";

import { checkSettingsArtifacts, generateSettingsArtifacts } from "./artifacts.ts";
import { discoverSettingsProjects } from "./projects.ts";

const HELP = `Usage: pi-extension-settings <command> [--root PATH]

Generate and verify TypeBox-derived Pi extension settings artifacts.

Commands:
  generate    Update config.schema.json and marked README sections.
  check       Fail when generated schema or README artifacts are stale.

Options:
  --root PATH  Standalone package or npm workspace root (default: current directory)
  --help       Show this help message
`;

export type CliIo = {
    readonly stdout: (message: string) => void;
    readonly stderr: (message: string) => void;
};

const processIo: CliIo = {
    stdout: process.stdout.write.bind(process.stdout),
    stderr: process.stderr.write.bind(process.stderr),
};

type ParsedArguments = {
    readonly command: "check" | "generate";
    readonly root: string;
};

function parseArguments(args: readonly string[]): ParsedArguments | undefined {
    const command = args[0];
    if (command !== "check" && command !== "generate") return undefined;

    let root = process.cwd();
    for (let index = 1; index < args.length; index += 1) {
        const argument = args[index];
        if (argument !== "--root") return undefined;
        const value = args[index + 1];
        if (value === undefined || value.startsWith("--")) return undefined;
        root = resolve(value);
        index += 1;
    }
    return { command, root };
}

function line(message: string): string {
    return message.endsWith("\n") ? message : `${message}\n`;
}

async function runCommand(parsed: ParsedArguments, io: CliIo): Promise<number> {
    const projects = await discoverSettingsProjects(parsed.root);
    if (projects.length === 0) {
        io.stderr(
            line(
                `No package.json with a piExtensionSettings manifest was found under ${parsed.root}`,
            ),
        );
        return 1;
    }

    if (parsed.command === "generate") {
        for (const project of projects) {
            const generated = generateSettingsArtifacts(project.definition, project.targets);
            for (const path of generated.changedPaths) io.stdout(line(`updated ${path}`));
        }
        return 0;
    }

    let stale = false;
    for (const project of projects) {
        const checked = checkSettingsArtifacts(project.definition, project.targets);
        for (const path of checked.stalePaths) {
            stale = true;
            io.stderr(line(`stale ${path}`));
        }
    }
    if (stale) {
        io.stderr(line("Run pi-extension-settings generate and commit the resulting changes."));
        return 1;
    }

    io.stdout(line(`settings artifacts are current (${projects.length} package(s))`));
    return 0;
}

export async function runCli(args: readonly string[], io: CliIo = processIo): Promise<number> {
    if (args.length === 0 || args.includes("--help")) {
        io.stdout(HELP);
        return 0;
    }

    const parsed = parseArguments(args);
    if (parsed === undefined) {
        io.stderr(line("Invalid arguments. Run pi-extension-settings --help for usage."));
        return 2;
    }

    try {
        return await runCommand(parsed, io);
    } catch (cause: unknown) {
        io.stderr(line(cause instanceof Error ? cause.message : String(cause)));
        return 1;
    }
}
