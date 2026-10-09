import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, test } from "vitest";

import {
    applyMentionProjectCliFlags,
    loadMentionProjectSettings,
    type MentionProjectSettingsContext,
} from "../src/settings.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = await mkdtemp(path.join(tmpdir(), "pi-mention-project-settings-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const globalConfigPath = path.join(agentDir, "extension-settings", "pi-mention-project.json");
const globalSchemaPath = path.join(
    agentDir,
    "extension-settings",
    "schemas",
    "pi-mention-project.schema.json",
);
const legacyGlobalSettingsPath = path.join(agentDir, "settings.json");

beforeEach(async () => {
    await rm(path.join(agentDir, "extension-settings"), { recursive: true, force: true });
    await rm(legacyGlobalSettingsPath, { force: true });
});

afterAll(async () => {
    await rm(agentDir, { recursive: true, force: true });

    if (originalAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
    } else {
        process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
});

function context(cwd: string, projectTrusted: boolean): MentionProjectSettingsContext {
    return {
        cwd,
        isProjectTrusted() {
            return projectTrusted;
        },
    };
}

type JsonValue =
    | boolean
    | number
    | string
    | null
    | readonly JsonValue[]
    | { readonly [key: string]: JsonValue };

type JsonObject = { readonly [key: string]: JsonValue };

async function writeJson(filePath: string, value: JsonObject): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(value), "utf8");
}

test("loadMentionProjectSettings uses defaults and scaffolds global config", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-mention-project-settings-cwd-"));
    try {
        assert.deepEqual(loadMentionProjectSettings(context(cwd, true)), {
            trigger: "#",
            roots: [],
            gitReposOnly: true,
            includeDotFolders: false,
            completionSuffix: " ",
            initialSuggestions: { strategy: "frecency", pinned: [] },
        });
        assert.deepEqual(JSON.parse(await readFile(globalConfigPath, "utf8")), {
            $schema: "./schemas/pi-mention-project.schema.json",
            trigger: "#",
            roots: [],
            gitReposOnly: true,
            includeDotFolders: false,
            completionSuffix: " ",
            initialSuggestions: { strategy: "frecency", pinned: [] },
        });
        assert.match(await readFile(globalSchemaPath, "utf8"), /Pi Mention Project settings/);
        const customConfig = JSON.stringify({ trigger: "@@", roots: ["~/Projects"] });
        await writeFile(globalConfigPath, customConfig, "utf8");
        await writeFile(globalSchemaPath, "stale schema", "utf8");

        assert.deepEqual(loadMentionProjectSettings(context(cwd, true)), {
            trigger: "@@",
            roots: ["~/Projects"],
            gitReposOnly: true,
            includeDotFolders: false,
            completionSuffix: " ",
            initialSuggestions: { strategy: "frecency", pinned: [] },
        });
        assert.equal(await readFile(globalConfigPath, "utf8"), customConfig);
        assert.match(await readFile(globalSchemaPath, "utf8"), /Pi Mention Project settings/);
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("loadMentionProjectSettings preserves legacy project mention settings", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-mention-project-settings-cwd-"));
    try {
        await writeJson(legacyGlobalSettingsPath, {
            mentionProjectTrigger: "@@",
            mentionProjectRoots: ["~/Projects"],
            mentionProjectGitReposOnly: false,
            mentionProjectIncludeDotFolders: true,
            mentionProjectCompletionSuffix: "\n",
        });
        await writeJson(path.join(cwd, ".pi", "settings.json"), {
            mentionProjectTrigger: "%%",
            mentionProjectRoots: ["./local-projects"],
            mentionProjectGitReposOnly: true,
            mentionProjectIncludeDotFolders: false,
            mentionProjectCompletionSuffix: "",
        });

        assert.deepEqual(loadMentionProjectSettings(context(cwd, true)), {
            trigger: "%%",
            roots: ["./local-projects"],
            gitReposOnly: true,
            includeDotFolders: false,
            completionSuffix: "",
            initialSuggestions: { strategy: "frecency", pinned: [] },
        });
        assert.deepEqual(loadMentionProjectSettings(context(cwd, false)), {
            trigger: "@@",
            roots: ["~/Projects"],
            gitReposOnly: false,
            includeDotFolders: true,
            completionSuffix: "\n",
            initialSuggestions: { strategy: "frecency", pinned: [] },
        });
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("new extension roots override legacy project mention roots", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-mention-project-settings-cwd-"));
    try {
        await writeJson(legacyGlobalSettingsPath, {
            mentionProjectTrigger: "@",
            mentionProjectRoots: ["~/Projects"],
        });
        await writeJson(globalConfigPath, { roots: ["./new-projects"] });

        assert.deepEqual(loadMentionProjectSettings(context(cwd, true)), {
            trigger: "@",
            roots: ["./new-projects"],
            gitReposOnly: true,
            includeDotFolders: false,
            completionSuffix: " ",
            initialSuggestions: { strategy: "frecency", pinned: [] },
        });
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("loadMentionProjectSettings falls back when config becomes unreadable", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-mention-project-settings-cwd-"));
    try {
        await writeJson(globalConfigPath, {
            trigger: "@",
            roots: ["~/Projects"],
        });

        assert.deepEqual(loadMentionProjectSettings(context(cwd, true)), {
            trigger: "@",
            roots: ["~/Projects"],
            gitReposOnly: true,
            includeDotFolders: false,
            completionSuffix: " ",
            initialSuggestions: { strategy: "frecency", pinned: [] },
        });

        await chmod(globalConfigPath, 0);

        assert.deepEqual(loadMentionProjectSettings(context(cwd, true)), {
            trigger: "#",
            roots: [],
            gitReposOnly: true,
            includeDotFolders: false,
            completionSuffix: " ",
            initialSuggestions: { strategy: "frecency", pinned: [] },
        });
    } finally {
        await chmod(globalConfigPath, 0o600).catch(() => undefined);
        await rm(cwd, { recursive: true, force: true });
    }
});

test("loadMentionProjectSettings applies global settings and trusted project overrides", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-mention-project-settings-cwd-"));
    try {
        await writeJson(globalConfigPath, {
            trigger: "@",
            roots: ["~/Projects"],
            gitReposOnly: false,
            includeDotFolders: true,
            completionSuffix: "\n",
            initialSuggestions: { strategy: "frequent", pinned: ["pi-tweaks"] },
        });
        await writeJson(path.join(cwd, ".pi", "extension-settings", "pi-mention-project.json"), {
            trigger: "%",
            roots: ["./local-projects"],
            gitReposOnly: true,
            includeDotFolders: false,
            completionSuffix: "",
            initialSuggestions: { strategy: "recent" },
        });

        assert.deepEqual(loadMentionProjectSettings(context(cwd, true)), {
            trigger: "%",
            roots: ["./local-projects"],
            gitReposOnly: true,
            includeDotFolders: false,
            completionSuffix: "",
            initialSuggestions: { strategy: "recent", pinned: ["pi-tweaks"] },
        });
        assert.deepEqual(loadMentionProjectSettings(context(cwd, false)), {
            trigger: "@",
            roots: ["~/Projects"],
            gitReposOnly: false,
            includeDotFolders: true,
            completionSuffix: "\n",
            initialSuggestions: { strategy: "frequent", pinned: ["pi-tweaks"] },
        });
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("loadMentionProjectSettings allows trusted project roots to clear global roots", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-mention-project-settings-cwd-"));
    try {
        await writeJson(globalConfigPath, {
            roots: ["~/Projects"],
        });
        await writeJson(path.join(cwd, ".pi", "extension-settings", "pi-mention-project.json"), {
            roots: [],
        });

        assert.deepEqual(loadMentionProjectSettings(context(cwd, true)), {
            trigger: "#",
            roots: [],
            gitReposOnly: true,
            includeDotFolders: false,
            completionSuffix: " ",
            initialSuggestions: { strategy: "frecency", pinned: [] },
        });
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("applyMentionProjectCliFlags can relax project filters for one run", () => {
    assert.deepEqual(
        applyMentionProjectCliFlags(
            {
                trigger: "#",
                roots: ["~/Projects"],
                gitReposOnly: true,
                includeDotFolders: false,
                completionSuffix: " ",
                initialSuggestions: { strategy: "frecency", pinned: [] },
            },
            { includeNonGit: true, includeDotFolders: true },
        ),
        {
            trigger: "#",
            roots: ["~/Projects"],
            gitReposOnly: false,
            includeDotFolders: true,
            completionSuffix: " ",
            initialSuggestions: { strategy: "frecency", pinned: [] },
        },
    );
});

test("loadMentionProjectSettings ignores invalid custom keys", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-mention-project-settings-cwd-"));
    try {
        await writeJson(globalConfigPath, {
            trigger: "/",
            roots: [""],
            gitReposOnly: "no",
            includeDotFolders: "yes",
            completionSuffix: false,
            initialSuggestions: { strategy: "newest" },
        });

        assert.deepEqual(loadMentionProjectSettings(context(cwd, true)), {
            trigger: "#",
            roots: [],
            gitReposOnly: true,
            includeDotFolders: false,
            completionSuffix: " ",
            initialSuggestions: { strategy: "frecency", pinned: [] },
        });
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("loadMentionProjectSettings rejects unknown config keys", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-mention-project-settings-cwd-"));
    try {
        await writeJson(globalConfigPath, {
            trigger: "@",
            triggerTypo: "%",
        });

        assert.deepEqual(loadMentionProjectSettings(context(cwd, true)), {
            trigger: "#",
            roots: [],
            gitReposOnly: true,
            includeDotFolders: false,
            completionSuffix: " ",
            initialSuggestions: { strategy: "frecency", pinned: [] },
        });
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});
