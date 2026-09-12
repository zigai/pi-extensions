import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";

it.each(["import", "registration"])("keeps settings unchanged during %s", async (phase) => {
    const root = await mkdtemp(join(tmpdir(), "pi-glowup-registration-contract-"));
    onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
    });

    const agentDir = join(root, "agent");
    const legacyDirectory = join(agentDir, "pi-glowup");
    await mkdir(legacyDirectory, { recursive: true });
    // A valid legacy document makes forbidden registration-time migration observable.
    await writeFile(join(legacyDirectory, "config.json"), "{}\n");
    const child = spawnSync(
        process.execPath,
        [
            "--import",
            new URL("../pty/fixtures/no-network.js", import.meta.url).href,
            "--import",
            import.meta.resolve("tsx"),
            fileURLToPath(new URL("./fixtures/register-without-session.ts", import.meta.url)),
            phase,
        ],
        {
            cwd: root,
            env: {
                PATH: process.env.PATH ?? "/usr/bin:/bin",
                HOME: root,
                PI_CODING_AGENT_DIR: agentDir,
                PI_OFFLINE: "1",
                PI_SKIP_VERSION_CHECK: "1",
            },
            encoding: "utf8",
            timeout: 10_000,
            killSignal: "SIGKILL",
            maxBuffer: 256 * 1024,
        },
    );

    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("completed without settings writes");
});
