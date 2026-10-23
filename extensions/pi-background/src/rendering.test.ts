import { expect, it } from "vitest";
import { startRendering, statusRendering, stopRendering } from "./rendering.ts";

const job = {
    id: "internal-job-id",
    command: "npm test",
    cwd: "/private/project",
    outputPath: "/private/output/log.txt",
    state: "completed" as const,
    exitCode: 7,
    error: null,
};

it("shows command state and requested output without internal job metadata", () => {
    const parsed = statusRendering.parseResult({
        details: { job, output: "one test failed", truncated: false },
    });
    const rendered = JSON.stringify(statusRendering.renderResult(parsed));

    expect(rendered).toContain("npm test");
    expect(rendered).toContain("exit 7");
    expect(rendered).toContain("one test failed");
    expect(rendered).not.toContain("internal-job-id");
    expect(rendered).not.toContain("/private");
});

it("keeps start and stop calls useful for restored and incomplete data", () => {
    expect(startRendering.parseArgs({ command: "npm test" })).toEqual({ command: "npm test" });
    expect(startRendering.parseArgs({ command: 7 })).toBeUndefined();
    expect(startRendering.parseArgs({})).toBeUndefined();
    expect(startRendering.renderCall({ command: "npm test" })).toBeDefined();
    expect(JSON.stringify(stopRendering.renderCall({ id: job.id }))).not.toContain(job.id);
});

it("reports unavailable error results without echoing raw IDs or log paths", () => {
    const parsed = stopRendering.parseResult({
        content: [{ type: "text", text: "Unknown internal-job-id /private/output/log.txt" }],
    });
    const rendered = JSON.stringify(stopRendering.renderResult(parsed));

    expect(rendered).toContain("unavailable");
    expect(rendered).not.toContain(job.id);
    expect(rendered).not.toContain("/private");
});
