import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ScriptFormatterProfile } from "../../../settings-input.ts";
import type { ScriptBlockFormatterOptions } from "./formatter.ts";

export type PreparedFormatterCommand = {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd?: string;
    readonly dispose?: () => Promise<void>;
};

export async function prepareFormatterCommand(
    profile: ScriptFormatterProfile,
    options: ScriptBlockFormatterOptions,
): Promise<PreparedFormatterCommand> {
    const signal = options.signal;
    const [command, ...args] = profile.command;

    if (command === undefined) throw new Error("Display formatter command is empty");
    if (profile.kind === "command") return { executable: command, args };

    let executable = command;
    if (!isAbsolute(command) && command.includes("/")) executable = resolve(command);

    const directory = await mkdtemp(join(tmpdir(), "pi-glowup-display-"));
    const dispose = async () => rm(directory, { recursive: true, force: true });
    const width = String(options.targetWidth ?? 88);

    try {
        signal?.throwIfAborted();

        switch (profile.kind) {
            case "python": {
                const layout = profile.collections ?? "ruff-default";
                await writeFile(
                    join(directory, "tuff.toml"),
                    `[format.collections]\nlists = { layout = "${layout}" }\ndicts = { layout = "${layout}" }\ntuples = { layout = "${layout}" }\nsets = { layout = "${layout}" }\n`,
                    { mode: 0o600, signal },
                );
                args.push(
                    "format",
                    "--isolated",
                    "--line-length",
                    width,
                    "--config",
                    `indent-width = ${profile.indentWidth ?? 4}`,
                    "--config",
                    `format.skip-magic-trailing-comma = ${!(profile.magicTrailingComma ?? false)}`,
                    "--stdin-filename",
                    join(directory, "script.py"),
                    "-",
                );

                break;
            }
            case "javascript":
            case "typescript": {
                const config = join(directory, "oxfmt.json");

                await writeFile(
                    config,
                    JSON.stringify({
                        printWidth: Number(width),
                        tabWidth: profile.tabWidth ?? 2,
                        objectWrap: profile.objectWrap ?? "collapse",
                    }),
                    { mode: 0o600, signal },
                );

                let filename = "script.js";
                if (profile.kind === "typescript") filename = "script.ts";
                args.push("--config", config, "--stdin-filepath", filename);
                break;
            }
            case "bash":
                args.push("-ln", "bash", "-i", String(profile.indentWidth ?? 2));

                if (profile.caseIndent ?? true) args.push("-ci");
                if (profile.spaceRedirects ?? true) args.push("-sr");
                if (profile.binaryNextLine ?? false) args.push("-bn");
                args.push("-");
                break;
        }

        signal?.throwIfAborted();
        return { executable, args, cwd: directory, dispose };
    } catch (cause: unknown) {
        await dispose();
        throw cause;
    }
}
