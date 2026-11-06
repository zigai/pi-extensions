import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// A subprocess gives explicit GC real event-loop boundaries. Keep a live empty
// owner, then keep only one child of a dropped owner: both retention directions
// must work while the extension remains installed.
test("live patch ownership does not retain removed children or dropped owners", () => {
    const script = fileURLToPath(new URL("../benchmark/assistant-composition.ts", import.meta.url));
    const stdout = execFileSync(process.execPath, ["--expose-gc", "--import", "tsx", script, "1"], {
        timeout: 30_000,
        encoding: "utf8",
    });
    expect(stdout).toContain('"steadyWeakRefs":0');
    expect(stdout).toContain('"removedChildCollectedBeforeDisposal":true');
    expect(stdout).toContain('"detachedAssistantCollected":true');
    expect(stdout).toContain('"detachedContainerCollected":true');
    expect(stdout).toContain('"detachedSiblingCollected":true');
    expect(stdout).toContain('"foreignDetachedOwnersCollected":true');
    expect(stdout).toContain('"detachedChildRestoredAfterDisposal":true');
    expect(stdout).toContain('"foreignDetachedChildrenRestoredAfterDisposal":true');
}, 40_000);
