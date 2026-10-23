import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const moduleUrl = new URL("../dist/diagnostics.js", import.meta.url).href;

function runDiagnostics(source: string) {
    const result = spawnSync(
        process.execPath,
        [
            "--input-type=module",
            "-e",
            `import { bindExtensionDiagnostics, reportExtensionDiagnostic } from ${JSON.stringify(moduleUrl)}; ${source}`,
        ],
        { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    return result;
}

it("buffers startup diagnostics and delivers them once through the UI without terminal writes", () => {
    const result = runDiagnostics(`
        const notices = [];
        reportExtensionDiagnostic("Startup warning");
        reportExtensionDiagnostic("Startup error", "error");
        const binding = bindExtensionDiagnostics({ hasUI: true, ui: { notify(message, severity) { notices.push({ message, severity }); } } });
        reportExtensionDiagnostic("Ready", "info");
        binding.dispose();
        process.stdout.write(JSON.stringify(notices));
    `);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
        JSON.stringify([
            { message: "Startup warning", severity: "warning" },
            { message: "Startup error", severity: "error" },
            { message: "Ready", severity: "info" },
        ]),
    );
});

it("writes headless diagnostics only after the mode is explicitly known", () => {
    const result = runDiagnostics(`
        reportExtensionDiagnostic("Queued before mode selection");
        const binding = bindExtensionDiagnostics({ hasUI: false });
        reportExtensionDiagnostic("Headless error", "error");
        binding.dispose();
    `);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Queued before mode selection\nHeadless error\n");
});

it("never falls back to the terminal when a notification fails", () => {
    const result = runDiagnostics(`
        const notices = [];
        const headless = bindExtensionDiagnostics({ hasUI: false, ui: { notify() {} } });
        const failed = bindExtensionDiagnostics({ hasUI: true, ui: { notify() { throw new Error("Unavailable UI"); } } });
        reportExtensionDiagnostic("Original failure", "error");
        failed.dispose();
        const healthy = bindExtensionDiagnostics({ hasUI: true, ui: { notify(message, severity) { notices.push({ message, severity }); } } });
        healthy.dispose();
        headless.dispose();
        process.stdout.write(JSON.stringify(notices));
    `);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
        JSON.stringify([{ message: "Original failure", severity: "error" }]),
    );
});

it("does not use disposed UI owners and buffers diagnostics until the next live binding", () => {
    const result = runDiagnostics(`
        const notices = [];
        const first = bindExtensionDiagnostics({ hasUI: true, ui: { notify(message) { notices.push("first:" + message); } } });
        const second = bindExtensionDiagnostics({ hasUI: true, ui: { notify(message) { notices.push("second:" + message); } } });
        first.dispose();
        reportExtensionDiagnostic("Active");
        second.dispose();
        second.dispose();
        reportExtensionDiagnostic("Between sessions");
        const next = bindExtensionDiagnostics({ hasUI: true, ui: { notify(message) { notices.push("next:" + message); } } });
        next.dispose();
        process.stdout.write(JSON.stringify(notices));
    `);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(JSON.stringify(["second:Active", "next:Between sessions"]));
});

it("keeps diagnostics in a live UI even when another caller supplies a headless context", () => {
    const result = runDiagnostics(`
        const notices = [];
        const binding = bindExtensionDiagnostics({ hasUI: true, ui: { notify(message) { notices.push(message); } } });
        reportExtensionDiagnostic("Still in the UI", "warning", { hasUI: false, ui: { notify() {} } });
        binding.dispose();
        process.stdout.write(JSON.stringify(notices));
    `);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(JSON.stringify(["Still in the UI"]));
});

it("shares routing across independently loaded copies and preserves reentrant reports", () => {
    const result = runDiagnostics(`
        const other = await import(${JSON.stringify(`${moduleUrl}?other-copy`)});
        const notices = [];
        const binding = bindExtensionDiagnostics({ hasUI: true, ui: { notify(message) {
            notices.push(message);
            if (message === "First") other.reportExtensionDiagnostic("Second");
        } } });
        other.reportExtensionDiagnostic("First");
        binding.dispose();
        process.stdout.write(JSON.stringify(notices));
    `);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(JSON.stringify(["First", "Second"]));
});
