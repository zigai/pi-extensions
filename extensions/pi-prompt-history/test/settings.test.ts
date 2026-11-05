import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { afterAll, expect, test } from "vitest";
import { loadPromptHistorySettings } from "../src/settings.ts";

const previous = process.env.PI_CODING_AGENT_DIR;
const root = await mkdtemp(join(process.cwd(), ".cache-history-settings-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
afterAll(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;

    await rm(root, { recursive: true, force: true });
});

test("defaults, each configured scope, trusted project precedence and safely preserved invalid layer", async () => {
    const cwd = join(root, "project");
    await mkdir(cwd);
    const context = { cwd, isProjectTrusted: () => false };
    const globalFile = join(root, "agent", "extension-settings", "pi-prompt-history.json");
    expect(loadPromptHistorySettings(context).settings).toEqual({
        enabled: true,
        defaultScope: "project",
    });

    for (const defaultScope of ["session", "project", "global"]) {
        await writeFile(globalFile, JSON.stringify({ defaultScope }));
        expect(loadPromptHistorySettings(context).settings.defaultScope).toBe(defaultScope);
    }

    const projectDirectory = join(cwd, CONFIG_DIR_NAME, "extension-settings");
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(
        join(projectDirectory, "pi-prompt-history.json"),
        JSON.stringify({ defaultScope: "session" }),
    );
    expect(loadPromptHistorySettings(context).settings.defaultScope).toBe("global");
    expect(
        loadPromptHistorySettings({ ...context, isProjectTrusted: () => true }).settings
            .defaultScope,
    ).toBe("session");
    const invalid = '{"defaultScope":"secret-invalid-value"}';
    await writeFile(globalFile, invalid);
    const loaded = loadPromptHistorySettings(context);
    expect(loaded.settings.defaultScope).toBe("project");
    expect(loaded.diagnostics.length).toBeGreaterThan(0);
    expect(JSON.stringify(loaded.diagnostics)).not.toContain("secret-invalid-value");
    expect(await readFile(globalFile, "utf8")).toBe(invalid);
}, 60_000);
