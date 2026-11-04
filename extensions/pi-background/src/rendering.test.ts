import { expect, it } from "vitest";
import { Value } from "typebox/value";
import { commandSchema } from "./commands.ts";
import {
    renderJobResult,
    renderOutputResult,
    renderStartCall,
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

it("restores pre-kind job results without weakening the current output contract", () => {
    const legacyJob = {
        id: job.id,
        command: job.command,
        cwd: job.cwd,
        outputPath: job.outputPath,
        state: job.state,
        exitCode: job.exitCode,
        error: job.error,
    };
    const result = { content: [], details: legacyJob };

    for (const renderer of [startRendering, statusRendering, stopRendering]) {
        expect(renderer.parseResult(result)).toEqual({
            kind: "available",
            job,
            output: "",
            truncated: false,
        });
    }

    const rendered = renderJobResult(result).render(120).join("\n");
    expect(rendered).toContain("task · npm test · exit 7");
    expect(Value.Check(commandSchema, legacyJob)).toBe(false);
    expect(Value.Check(commandSchema, job)).toBe(true);
});

it("restores pre-kind status output in both renderers without changing saved details", () => {
    const { kind: _kind, ...legacyJob } = job;
    const result = {
        content: [],
        details: { job: legacyJob, output: "one test failed", truncated: true },
    };
    const original = structuredClone(result);
    const parsed = statusRendering.parseResult(result);
    expect(parsed).toEqual({
        kind: "available",
        job,
        output: "one test failed",
        truncated: true,
    });

    const glowup = JSON.stringify(statusRendering.renderResult(parsed));
    const fallback = renderOutputResult(result, { expanded: true, isPartial: false })
        .render(120)
        .join("\n");

    for (const rendered of [glowup, fallback]) {
        expect(rendered).toContain("task · npm test · exit 7");
        expect(rendered).toContain("one test failed");
        expect(rendered).toContain("Earlier output omitted");
        expect(rendered).not.toContain("unavailable");
    }

    expect(result).toEqual(original);
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

it("renders a collected batch with bounded output nodes and expandable fallback output", () => {
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
    expect(glowup).toContain("npm test");
    expect(glowup).toContain("exit 7");
    expect(glowup).toContain("npm run build");
    expect(glowup).toContain("done");
    expect(glowup).toContain('"kind":"output"');
    expect(glowup).toContain("one test failed");
    expect(glowup).toContain("Earlier output omitted");

    const collapsed = renderWaitResult(result, { expanded: false, isPartial: false })
        .render(120)
        .join("\n");
    const expanded = renderWaitResult(result, { expanded: true, isPartial: false })
        .render(120)
        .join("\n");
    expect(collapsed).toContain("npm test");
    expect(collapsed).toContain("npm run build");
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
        renderWaitResult(result, { expanded: true, isPartial: false }).render(100).join("\n"),
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
        const fallback = renderWaitResult(invalid, { expanded: true, isPartial: false })
            .render(100)
            .join("\n");
        expect(glowup + fallback).toContain("unavailable");
        expect(glowup + fallback).not.toContain(job.id);
        expect(glowup + fallback).not.toContain("/private");
    }
});
