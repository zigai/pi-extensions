import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import { listProjectDirectories, resolveProjectRoot } from "../src/projects.ts";
import type { MentionProjectSettings } from "../src/settings.ts";

function settings(
    roots: string[],
    overrides: Partial<MentionProjectSettings> = {},
): MentionProjectSettings {
    return {
        trigger: "#",
        roots,
        gitReposOnly: true,
        includeDotFolders: false,
        completionSuffix: " ",
        initialSuggestions: { strategy: "frecency", pinned: [] },
        ...overrides,
    };
}

async function markGitRepo(projectPath: string): Promise<void> {
    await mkdir(path.join(projectPath, ".git"), { recursive: true });
}

test("resolveProjectRoot resolves relative roots from cwd", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-mention-project-cwd-"));
    try {
        assert.equal(resolveProjectRoot("projects", cwd), path.join(cwd, "projects"));
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("listProjectDirectories lists only direct child git directories and ignores dot folders by default", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-mention-project-roots-"));
    try {
        const firstRoot = path.join(dir, "first");
        const secondRoot = path.join(dir, "second");
        const alpha = path.join(firstRoot, "alpha");
        const beta = path.join(firstRoot, "beta");
        const hidden = path.join(firstRoot, ".hidden");
        const nonGit = path.join(firstRoot, "non-git");
        const duplicateAlpha = path.join(secondRoot, "alpha");
        const gamma = path.join(secondRoot, "gamma");

        await mkdir(path.join(alpha, "nested", ".git"), { recursive: true });
        await mkdir(beta, { recursive: true });
        await mkdir(hidden, { recursive: true });
        await mkdir(nonGit, { recursive: true });
        await mkdir(duplicateAlpha, { recursive: true });
        await mkdir(gamma, { recursive: true });
        await markGitRepo(alpha);
        await markGitRepo(beta);
        await markGitRepo(hidden);
        await markGitRepo(duplicateAlpha);
        await markGitRepo(gamma);
        await writeFile(path.join(firstRoot, "file.txt"), "not a project", "utf8");

        const projects = await listProjectDirectories(settings([firstRoot, secondRoot]), dir);

        assert.deepEqual(
            projects.map((project) => project.name),
            ["alpha", "beta", "gamma"],
        );
        assert.deepEqual(
            projects.map((project) => project.path),
            [alpha, beta, gamma],
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("listProjectDirectories can include non-git and dot folders when configured", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-mention-project-filter-"));
    try {
        const root = path.join(dir, "root");
        await mkdir(path.join(root, "regular"), { recursive: true });
        await mkdir(path.join(root, ".hidden"), { recursive: true });

        const projects = await listProjectDirectories(
            settings([root], { gitReposOnly: false, includeDotFolders: true }),
            dir,
        );

        assert.deepEqual(
            projects.map((project) => project.name),
            [".hidden", "regular"],
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("listProjectDirectories includes symlinks to git directories", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-mention-project-symlink-"));
    try {
        const root = path.join(dir, "root");
        const target = path.join(dir, "target");
        await mkdir(root, { recursive: true });
        await mkdir(target, { recursive: true });
        await markGitRepo(target);
        await symlink(target, path.join(root, "linked"));

        const projects = await listProjectDirectories(settings([root]), dir);

        assert.deepEqual(
            projects.map((project) => project.name),
            ["linked"],
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("listProjectDirectories returns no projects when already aborted", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-mention-project-aborted-"));
    try {
        const root = path.join(dir, "root");
        const alpha = path.join(root, "alpha");
        await mkdir(alpha, { recursive: true });
        await markGitRepo(alpha);
        const controller = new AbortController();
        controller.abort();

        const projects = await listProjectDirectories(settings([root]), dir, {
            signal: controller.signal,
        });

        assert.deepEqual(projects, []);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
