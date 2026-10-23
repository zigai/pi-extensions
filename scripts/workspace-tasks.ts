import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadWorkspacePackages, type WorkspacePackage } from "./workspace-packages.ts";

export const isolatedDirectories = new Set([
    "extensions/pi-autoname-session",
    "extensions/pi-branch",
    "extensions/pi-codex-core",
    "extensions/pi-glowup",
    "extensions/pi-goal",
    "extensions/pi-settings-ui",
    "extensions/pi-toggles",
    "extensions/pi-expanded-skills",
    "extensions/pi-lazy-mcp",
    "packages/pi-extension-settings",
    "packages/pi-typed-args",
]);

export function planWorkspaceBuild(packages: readonly WorkspacePackage[]): WorkspacePackage[] {
    const byName = new Map(packages.map((workspace) => [workspace.manifest.name, workspace]));
    const active = new Set<string>();
    const visited = new Set<string>();
    const ordered: WorkspacePackage[] = [];

    function visit(workspace: WorkspacePackage): void {
        const { manifest } = workspace;
        if (active.has(manifest.name))
            throw new Error(`Workspace build dependency cycle: ${manifest.name}`);
        if (visited.has(manifest.name)) return;

        active.add(manifest.name);

        for (const [name, version] of Object.entries({
            ...manifest.dependencies,
            ...manifest.optionalDependencies,
        })) {
            const dependency = byName.get(name);
            if (dependency?.manifest.version === version) visit(dependency);
        }

        active.delete(manifest.name);
        visited.add(manifest.name);

        if (manifest.scripts?.build !== undefined) ordered.push(workspace);
    }

    const settings = byName.get("@zigai/pi-extension-settings");
    if (settings !== undefined) visit(settings);

    for (const workspace of packages) visit(workspace);

    return ordered;
}

function run(root: string, executable: string, args: readonly string[]): void {
    const windowsShim = process.platform === "win32" && executable !== "node";
    if (windowsShim) executable += ".cmd";

    execFileSync(executable, [...args], {
        cwd: root,
        stdio: "inherit",
        shell: windowsShim,
    });
}

export function runWorkspaceTask(root: string, task: string, args: readonly string[] = []): void {
    let rootOnly = false;
    if (task.endsWith(":root")) {
        rootOnly = true;
        task = task.slice(0, -5);
    }

    if (["lint", "lint:fix", "format", "format:check"].includes(task)) {
        run(root, "node", ["scripts/tracked-check.ts", task, ...args]);
        return;
    }

    const inventory = loadWorkspacePackages(root, false);
    if (task === "build") {
        const builds = planWorkspaceBuild(inventory.packages);
        for (const workspace of builds) {
            run(root, "npm", ["run", "build", "-w", workspace.manifest.name]);
        }

        if (builds.length > 0)
            run(root, "npm", ["rebuild", ...builds.map(({ manifest }) => manifest.name)]);

        return;
    }

    if (task === "clean") {
        for (const workspace of inventory.packages) {
            rmSync(path.join(workspace.directory, "dist"), { recursive: true, force: true });
            rmSync(path.join(workspace.directory, "coverage"), { recursive: true, force: true });
        }

        rmSync(path.join(root, "coverage"), { recursive: true, force: true });

        return;
    }

    const isolated = inventory.packages.filter((workspace) =>
        isolatedDirectories.has(path.relative(root, workspace.directory)),
    );
    if (task === "check:code:workspaces") {
        for (const workspace of isolated)
            run(root, "npm", ["run", "check:code", "-w", workspace.manifest.name]);

        return;
    }

    if (task === "test" || task === "coverage") {
        const testArgs = ["run", "--config", "vitest.config.ts", "--maxWorkers=8"];
        if (task === "coverage") testArgs.push("--coverage");
        run(root, "vitest", [...testArgs, ...args]);
    } else if (task === "typecheck") {
        run(root, "tsc", ["--noEmit"]);
    } else {
        throw new Error(`Unknown workspace task: ${task}`);
    }

    if (rootOnly) return;

    for (const workspace of isolated) {
        if (workspace.manifest.scripts?.[task] === undefined)
            throw new Error(`${workspace.manifest.name} does not declare ${task}`);

        run(root, "npm", ["run", task, "-w", workspace.manifest.name, "--", ...args]);
    }
}

const entry = process.argv.at(1);
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
    const task = process.argv.at(2);
    if (task === undefined) throw new Error("Usage: node scripts/workspace-tasks.ts <task>");

    runWorkspaceTask(process.cwd(), task, process.argv.slice(3));
}
