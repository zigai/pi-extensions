import { execFileSync } from "node:child_process";
import path from "node:path";
import { isolatedDirectories } from "./workspace-tasks.ts";
import { isWithinDirectory, loadWorkspacePackages } from "./workspace-packages.ts";

const root = process.cwd();
const task = process.argv.at(2);
if (task !== "lint" && task !== "format")
    throw new Error("Usage: node scripts/tracked-check.ts <lint|format>");
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((file) => file.length > 0);
const inventory = loadWorkspacePackages(root, false);
const isolated = inventory.packages.filter((workspace) =>
    isolatedDirectories.has(path.relative(root, workspace.directory)),
);
const shared = tracked.filter(
    (file) =>
        !isolated.some((workspace) =>
            isWithinDirectory(workspace.directory, path.join(root, file)),
        ),
);

function check(
    cwd: string,
    files: readonly string[],
    config: string,
    disableTypescript = false,
): void {
    if (files.length === 0) return;
    let executable = path.join(root, "node_modules", ".bin", "oxfmt");
    let args = ["--check", ...files];
    if (task === "lint") {
        executable = path.join(root, "node_modules", ".bin", "oxlint");
        args = ["-c", config, ...files];
        if (disableTypescript) args.push("--disable-typescript-plugin");
    }
    execFileSync(executable, args, { cwd, stdio: "inherit" });
}

check(root, shared, "./oxlint.config.ts");
for (const workspace of isolated) {
    const files = tracked
        .filter((file) => isWithinDirectory(workspace.directory, path.join(root, file)))
        .map((file) => path.relative(workspace.directory, path.join(root, file)));
    if (task === "format") {
        check(workspace.directory, files, "");
        continue;
    }
    const command = workspace.manifest.scripts?.lint;
    const config = command?.match(/(?:^|\s)oxlint\s+-c\s+(\S+)/u)?.[1];
    if (config === undefined)
        throw new Error(`${workspace.manifest.name}: lint configuration is not declared`);
    const stages = workspace.manifest.lintStages ?? [{ targets: ["."], disableTypescript: false }];
    for (const stage of stages) {
        const targets = stage.targets.map((target) => path.resolve(workspace.directory, target));
        check(
            workspace.directory,
            files.filter((file) =>
                targets.some((target) =>
                    isWithinDirectory(target, path.resolve(workspace.directory, file)),
                ),
            ),
            config,
            stage.disableTypescript ?? false,
        );
    }
}
