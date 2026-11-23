import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { beforeEach, expect, it } from "vitest";
import { jobOutcomes, RESULT_MESSAGE_TYPE } from "./job-outcomes.ts";
import {
    parseResultDetails,
    renderResultMessage,
    renderStartCall,
    renderStartResult,
    renderWaitCall,
    renderWaitResult,
    startRendering,
    statusRendering,
    stopRendering,
    waitRendering,
} from "./rendering.ts";

const theme = {
    fg: (_color: string, value: string) => value,
    bold: (value: string) => value,
};

const job = {
    id: "internal-job-id",
    command: "npm test",
    kind: "task" as const,
    cwd: "/private/project",
    outputPath: "/private/output/log.txt",
    state: "completed" as const,
    exitCode: 7,
    error: null,
    startedAt: 1_000,
    endedAt: 2_000,
    lastOutputAt: 1_500,
    timeoutSeconds: 1800,
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

it.each(["unknown", null, 7])(
    "rejects invalid saved job kinds instead of defaulting %j",
    (kind) => {
        expect(statusRendering.parseResult({ details: { ...job, kind } })).toEqual({
            kind: "unavailable",
        });

        expect(
            statusRendering.parseResult({
                details: { job: { ...job, kind }, output: "output", truncated: false },
            }),
        ).toEqual({ kind: "unavailable" });
    },
);

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

it("distinguishes finite tasks from services in start calls and result labels", () => {
    expect(renderStartCall({ command: "npm test" }, theme).render(100).join("\n")).toContain(
        "Background task",
    );

    expect(
        renderStartCall({ command: "npm start", kind: "service" }, theme).render(100).join("\n"),
    ).toContain("Background service");

    expect(JSON.stringify(startRendering.renderCall({ command: "npm test" }))).toContain("Task");
    expect(
        JSON.stringify(startRendering.renderCall({ command: "npm start", kind: "service" })),
    ).toContain("Service");
    const parsed = statusRendering.parseResult({ details: { ...job, kind: "service" } });
    expect(JSON.stringify(statusRendering.renderResult(parsed))).toContain("service");
});

it("parses wait arguments and hides selected task IDs in both call renderers", () => {
    expect(waitRendering.parseArgs({})).toEqual({});
    expect(waitRendering.parseArgs({ ids: [job.id] })).toEqual({ ids: [job.id] });
    expect(waitRendering.parseArgs({ ids: [] })).toBeUndefined();
    expect(waitRendering.parseArgs({ ids: [7] })).toBeUndefined();
    expect(waitRendering.parseArgs({ ids: [job.id, job.id] })).toBeUndefined();
    const glowup = JSON.stringify(waitRendering.renderCall({ ids: [job.id] }));
    const fallback = renderWaitCall({ ids: [job.id] }, theme)
        .render(100)
        .join("\n");
    expect(glowup).toContain("Background Tasks");
    expect(fallback).toContain("background tasks");
    expect(glowup + fallback).not.toContain(job.id);
});

it("renders a collected batch as one status line per task, with output only in expanded fallback", () => {
    const result = {
        content: [],
        details: {
            timedOut: false,
            jobs: [
                { job, output: "one test failed", truncated: true },
                {
                    job: { ...job, command: "npm run build", exitCode: 0 },
                    output: "build passed",
                    truncated: false,
                },
            ],
        },
    };
    const parsed = waitRendering.parseResult(result);
    const glowup = JSON.stringify(waitRendering.renderResult(parsed));
    expect(glowup).toContain("✗ npm test exit 7 · 1s");
    expect(glowup).toContain("✓ npm run build done · 1s");
    expect(glowup).not.toContain("one test failed");
    expect(glowup).not.toContain("build passed");

    const collapsed = renderWaitResult(result, { expanded: false, isPartial: false }, theme)
        .render(120)
        .map((line) => line.trimEnd())
        .join("\n");
    const expanded = renderWaitResult(result, { expanded: true, isPartial: false }, theme)
        .render(120)
        .join("\n");
    expect(collapsed).toBe("✗ npm test exit 7 · 1s\n✓ npm run build done · 1s");
    expect(collapsed).not.toContain("one test failed");
    expect(collapsed).not.toContain("build passed");
    expect(expanded).toContain("one test failed");
    expect(expanded).toContain("build passed");
    expect(expanded).toContain("Earlier output omitted");
    expect(glowup + collapsed + expanded).not.toContain(job.id);
    expect(glowup + collapsed + expanded).not.toContain("/private");
});

it("gives empty waits useful wording in both renderers", () => {
    const result = { content: [], details: { jobs: [], timedOut: false } };
    expect(JSON.stringify(waitRendering.renderResult(waitRendering.parseResult(result)))).toContain(
        "No outstanding background tasks.",
    );

    expect(
        renderWaitResult(result, { expanded: true, isPartial: false }, theme)
            .render(100)
            .join("\n"),
    ).toContain("No outstanding background tasks.");
});

it("renders unavailable wait errors safely instead of exposing raw tool errors", () => {
    const result = {
        content: [{ type: "text" as const, text: `Unknown ${job.id} /private/output/log.txt` }],
    };
    for (const details of [undefined, { jobs: [{ job, output: 7, truncated: false }] }]) {
        const invalid = { ...result, details };
        const glowup = JSON.stringify(
            waitRendering.renderResult(waitRendering.parseResult(invalid)),
        );
        const fallback = renderWaitResult(invalid, { expanded: true, isPartial: false }, theme)
            .render(100)
            .join("\n");
        expect(glowup + fallback).toContain("unavailable");
        expect(glowup + fallback).not.toContain(job.id);
        expect(glowup + fallback).not.toContain("/private");
    }
});

it("shows a delivered result as one status line and its output only when expanded", () => {
    const result = parseResultDetails({
        job: { ...job, state: "timed_out", exitCode: null },
        output: "hung",
        truncated: false,
    });
    const render = (value: typeof result, expanded: boolean) =>
        renderResultMessage(value, { expanded }, theme)
            .render(120)
            .map((line) => line.trim())
            .join("\n");

    expect(render(result, false)).toBe("Background ✗ npm test timed out · 1s");
    expect(render(result, false)).not.toContain("hung");
    expect(render(result, true)).toContain("hung");
    expect(render(parseResultDetails({}), false)).toContain("unavailable");
});

const renderOptions = { expanded: false, isPartial: false };

function startRow(id: string, invalidate: () => void = () => {}) {
    const launched = { ...job, id, state: "running" as const, exitCode: null, endedAt: null };

    return renderStartResult({ content: [], details: launched }, renderOptions, theme, {
        args: { command: job.command },
        toolCallId: `call-${id}`,
        invalidate,
        lastComponent: undefined,
        state: {},
        cwd: "/private/project",
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        expanded: false,
        showImages: false,
        isError: false,
        durationMs: undefined,
        outputPad: 0,
        keyText: () => "",
        keyHint: () => "",
    });
}

function rendered(row: ReturnType<typeof startRow>): string {
    return row.render(120).join("\n");
}

beforeEach(() => {
    jobOutcomes.clear();
});

it("shows a running job under its call, then its outcome once the job ends", () => {
    let invalidated = 0;
    jobOutcomes.started({ ...job, id: "live", state: "running", exitCode: null, endedAt: null });
    const row = startRow("live", () => {
        invalidated += 1;
    });
    expect(rendered(row)).toBe("  └ ▷ npm test running");

    const lines = Array.from({ length: 7 }, (_, index) => `line ${index + 1}`);
    jobOutcomes.record({ job: { ...job, id: "live" }, output: lines.join("\n"), truncated: false });

    expect(invalidated).toBe(1);
    expect(rendered(row).split("\n")).toEqual([
        "  └ ✗ npm test exit 7 · 1s",
        "    … 2 earlier lines",
        "    line 3",
        "    line 4",
        "    line 5",
        "    line 6",
        "    line 7",
    ]);
});

it("restores outcomes from a saved session so resumed calls still show how they ended", () => {
    const entry = { id: "entry", parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };

    const entries: SessionEntry[] = [
        {
            ...entry,
            type: "custom_message",
            customType: RESULT_MESSAGE_TYPE,
            content: "delivered",
            display: true,
            details: { job: { ...job, id: "delivered" }, output: "from message", truncated: false },
        },
        {
            ...entry,
            type: "message",
            message: {
                role: "toolResult",
                toolCallId: "wait",
                toolName: "background_wait",
                content: [],
                isError: false,
                timestamp: 0,
                details: {
                    timedOut: false,
                    jobs: [
                        {
                            job: { ...job, id: "waited", exitCode: 0 },
                            output: "from wait",
                            truncated: false,
                        },
                    ],
                },
            },
        },
    ];

    const delivered = startRow("delivered");
    jobOutcomes.restore(entries);

    expect(rendered(delivered)).toBe("  └ ✗ npm test exit 7 · 1s\n    from message");
    expect(rendered(startRow("waited"))).toBe("  └ ✓ npm test done · 1s\n    from wait");
    expect(rendered(startRow("lost"))).toBe("  └ ended without a recorded result");
});
