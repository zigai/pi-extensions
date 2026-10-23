import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkspacePackages } from "./workspace-packages.ts";
import { loadReleasePackages, planWorkspacePublish } from "./publish-workspace.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventory = loadWorkspacePackages(root);
if (inventory.collections.length === 0) throw new Error("Collection workspace is missing");

const releases = loadReleasePackages(root);
const selected = new Set(
    inventory.defaultExtensions
        .flatMap(({ workspace }) => planWorkspacePublish(releases, workspace.manifest.name))
        .map(({ name }) => name),
);
const cacheRoot = path.join(homedir(), ".cache", "pi-tweaks", "collection");
mkdirSync(cacheRoot, { recursive: true });

const temporary = mkdtempSync(path.join(cacheRoot, "run-"));
let npm = "npm";
if (process.platform === "win32") npm += ".cmd";

try {
    const tarballs: string[] = [];
    for (const workspace of inventory.packages) {
        if (!selected.has(workspace.manifest.name)) continue;

        const output = execFileSync(
            npm,
            ["pack", "--silent", "--ignore-scripts", "--pack-destination", temporary],
            {
                cwd: workspace.directory,
                encoding: "utf8",
                shell: process.platform === "win32",
            },
        );
        const filename = output.trim().split(/\r?\n/u).at(-1);
        if (filename === undefined || filename.length === 0)
            throw new Error(`Missing tarball for ${workspace.manifest.name}`);

        tarballs.push(path.join(temporary, filename));
    }

    for (const collection of inventory.collections) {
        rmSync(path.join(collection.directory, "node_modules"), { recursive: true, force: true });
        execFileSync(
            npm,
            [
                "install",
                ...tarballs,
                "--prefix",
                collection.directory,
                "--no-save",
                "--workspaces=false",
                "--ignore-scripts",
                "--legacy-peer-deps",
                "--omit=dev",
                "--package-lock=false",
                "--prefer-offline",
            ],
            {
                cwd: root,
                stdio: "inherit",
                shell: process.platform === "win32",
            },
        );
    }
} finally {
    rmSync(temporary, { recursive: true, force: true });
}
