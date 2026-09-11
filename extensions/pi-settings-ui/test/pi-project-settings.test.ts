import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadPiProjectSettings, savePiProjectSetting } from "../src/pi-project-settings.ts";

async function projectDirectory(): Promise<string> {
    return mkdtemp(join(tmpdir(), "pi-settings-ui-project-"));
}

describe("Pi project settings", () => {
    it("writes nested project overrides without losing unrelated settings", async () => {
        const cwd = await projectDirectory();
        const path = join(cwd, ".pi", "settings.json");
        await mkdir(join(cwd, ".pi"), { recursive: true });
        await writeFile(path, '{"unrelated":{"keep":true},"terminal":{"showImages":true}}\n');
        const snapshot = await loadPiProjectSettings(cwd, true);

        const outcome = await savePiProjectSetting(snapshot, ["terminal", "clearOnShrink"], false);
        expect(outcome._tag).toBe("ProjectSettingSaved");
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
            unrelated: { keep: true },
            terminal: { showImages: true, clearOnShrink: false },
        });
    });

    it("blocks untrusted, malformed, and concurrently changed project files", async () => {
        const cwd = await projectDirectory();
        const path = join(cwd, ".pi", "settings.json");
        await mkdir(join(cwd, ".pi"), { recursive: true });
        await writeFile(path, "{");

        expect(await loadPiProjectSettings(cwd, false)).toMatchObject({
            _tag: "UnavailableProjectSettings",
        });

        expect(await loadPiProjectSettings(cwd, true)).toMatchObject({
            _tag: "BlockedProjectSettings",
        });

        await writeFile(path, '{"theme":"dark"}\n');
        const snapshot = await loadPiProjectSettings(cwd, true);
        await writeFile(path, '{"theme":"light"}\n');
        const outcome = await savePiProjectSetting(snapshot, ["theme"], "other");
        expect(outcome).toMatchObject({ _tag: "ProjectSettingSaveFailed" });
        expect(await readFile(path, "utf8")).toBe('{"theme":"light"}\n');
    });
});
