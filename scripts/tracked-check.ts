import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isWithinDirectory, loadWorkspacePackages } from "./workspace-packages.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = process.cwd();
const task = process.argv.at(2);
if (!["lint", "lint:fix", "format", "format:check"].includes(task ?? ""))
    throw new Error("Usage: node scripts/tracked-check.ts <lint|lint:fix|format|format:check>");

if (!isWithinDirectory(root, directory)) throw new Error("Tooling must run within the repository");

const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
        cwd: root,
        encoding: "utf8",
    },
)
    .split("\0")
    .filter(
        (file) =>
            file.length > 0 &&
            existsSync(path.join(root, file)) &&
            isWithinDirectory(directory, path.join(root, file)),
    );

function check(files: readonly string[]): void {
    if (files.length === 0) return;

    let executable = path.join(root, "node_modules", ".bin", "oxfmt");
    let args = ["-c", path.join(root, ".oxfmtrc.json"), ...files];
    if (task === "format:check") args.push("--check");

    if (task === "lint" || task === "lint:fix") {
        executable = path.join(root, "node_modules", ".bin", "oxlint");
        args = ["-c", path.join(root, "oxlint.config.ts"), ...files];
        if (task === "lint:fix") args.push("--fix");
    }

    if (process.platform === "win32") executable += ".cmd";

    execFileSync(executable, [...args, ...process.argv.slice(3)], {
        cwd: root,
        stdio: "inherit",
        shell: process.platform === "win32",
    });
}

if (task === "format" || task === "format:check") {
    check(files);
} else {
    const inventory = loadWorkspacePackages(root, false);
    const workspacesWithStages = inventory.packages.filter(
        (workspace) => workspace.manifest.lintStages !== undefined,
    );

    check(
        files.filter(
            (file) =>
                !workspacesWithStages.some((workspace) =>
                    isWithinDirectory(workspace.directory, path.join(root, file)),
                ),
        ),
    );

    for (const workspace of workspacesWithStages) {
        for (const stage of workspace.manifest.lintStages ?? []) {
            const targets = stage.targets.map((target) =>
                path.resolve(workspace.directory, target),
            );

            check(
                files.filter((file) =>
                    targets.some((target) => isWithinDirectory(target, path.join(root, file))),
                ),
            );
        }
    }
}
