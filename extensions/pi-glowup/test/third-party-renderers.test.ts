import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { GlowupRenderTheme } from "../src/rendering/core.ts";
import {
    call,
    code,
    empty,
    list,
    mutation,
    output,
    stack,
    summary,
    text,
    type GlowupRenderer,
} from "../src/tool-rendering/protocol.ts";
import {
    GLOWUP_RENDERING_PROPERTY,
    createThirdPartyToolRenderer,
    hasGlowupRenderingAdapter,
    parsePreservedThirdPartyToolNames,
    shouldPreserveThirdPartyToolRenderer,
} from "../src/third-party-tools/renderers.ts";

const plainTheme: GlowupRenderTheme = {
    fg(token: string, text: string): string {
        return token === "accent" ? `<accent>${text}</accent>` : text;
    },
    bg(_token: string, text: string): string {
        return text;
    },
    bold(text: string): string {
        return text;
    },
};

const renderContext = {
    args: {},
    toolCallId: "call-1",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
};

function createLifecycleRenderer(toolName: string) {
    return createThirdPartyToolRenderer(toolName, { labelMode: "lifecycle" });
}

function stripAccentStyle(text: string): string {
    return text.replaceAll("<accent>", "").replaceAll("</accent>", "");
}

function compactRenderedText(text: string): string {
    return text.replace(/[│└]/gu, " ").replace(/\s+/gu, " ");
}

function expectWellFormedLines(lines: readonly string[]): void {
    for (const line of lines) {
        expect(Buffer.from(line, "utf8").toString("utf8")).toBe(line);
    }
}

describe("third-party tool renderers", () => {
    it("keeps every renderer family within tiny terminal widths", () => {
        const cases: ReadonlyArray<{ readonly toolName: string; readonly args: unknown }> = [
            { toolName: "agent_browser", args: { args: ["open", "https://example.com"] } },
            { toolName: "mcp", args: { connect: "chrome-devtools" } },
            { toolName: "finalize_plan", args: { markdown: "# Plan\n\nLong plan body" } },
            {
                toolName: "ask_user_question",
                args: {
                    questions: [
                        {
                            header: "Mode",
                            question: "Which mode should be selected?",
                            options: [{ label: "Safe", description: "Use safe mode" }],
                        },
                    ],
                },
            },
            { toolName: "get_goal", args: {} },
            { toolName: "Agent", args: { description: "Inspect renderer behavior" } },
            { toolName: "web_run", args: { search_query: [{ q: "latest Pi documentation" }] } },
            { toolName: "imagegen", args: { prompt: "long visual prompt ".repeat(30) } },
            { toolName: "view_image", args: { path: "/tmp/世界/very-long-preview-name.png" } },
            { toolName: "unknown_tool", args: { nested: { value: "hello 世界" } } },
        ];

        for (const testCase of cases) {
            const renderer = createThirdPartyToolRenderer(testCase.toolName, {
                labelMode: "lifecycle",
            });
            for (const width of [1, 8, 23, 50]) {
                const lines = renderer
                    .renderCall(testCase.args, plainTheme, renderContext)
                    .render(width);
                for (const line of lines) {
                    expect(
                        visibleWidth(stripAccentStyle(line)),
                        `${testCase.toolName} exceeded width ${width}`,
                    ).toBeLessThanOrEqual(width);
                }
                expectWellFormedLines(lines);
            }
        }
    });

    it("renders owner-provided semantic mutations as separate responsive file blocks", () => {
        const glowupRendering = {
            version: 3,
            parseArgs(value: unknown) {
                return typeof value === "object" && value !== null ? {} : undefined;
            },
            renderCall() {
                return mutation(
                    { static: "Patch", running: "Patching", completed: "Patched" },
                    [
                        {
                            path: "src/a.ts",
                            lines: [
                                {
                                    kind: "addition" as const,
                                    text: "export const a = 1;",
                                    newLine: 1,
                                },
                            ],
                            added: 1,
                            removed: 0,
                        },
                        {
                            path: "src/b.ts",
                            lines: [
                                {
                                    kind: "deletion" as const,
                                    text: "export const b = 1;",
                                    oldLine: 1,
                                },
                                {
                                    kind: "addition" as const,
                                    text: "export const b = 2;",
                                    newLine: 1,
                                },
                            ],
                            added: 1,
                            removed: 1,
                        },
                    ],
                    {
                        patch:
                            "--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+export const a = 1;\n" +
                            "--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-export const b = 1;\n+export const b = 2;\n",
                    },
                );
            },
        } as const;
        const renderer = createThirdPartyToolRenderer(
            "apply_patch",
            { labelMode: "lifecycle" },
            { glowupRendering },
        );

        for (const width of [24, 80, 180]) {
            const lines = renderer.renderCall({}, plainTheme, renderContext).render(width);
            const rendered = stripAccentStyle(lines.join("\n"));
            expect(rendered.match(/Patch(?:ing|ed)/gu)).toHaveLength(2);
            if (width >= 80) {
                expect(rendered).toContain("src/a.ts");
                expect(rendered).toContain("src/b.ts");
            }
            expect(rendered).not.toContain('{"files"');
            for (const line of lines) {
                expect(visibleWidth(stripAccentStyle(line))).toBeLessThanOrEqual(width);
            }
        }
    });

    it("uses passive glowupRendering adapters when present", () => {
        type DbQueryArgs = {
            readonly sql: string;
        };
        type DbQueryResult = {
            readonly details?: {
                readonly rowCount?: number;
            };
        };
        const rendering = {
            version: 3,
            parseArgs(value: unknown): DbQueryArgs | undefined {
                if (typeof value !== "object" || value === null || !("sql" in value)) {
                    return undefined;
                }
                return typeof value.sql === "string" ? { sql: value.sql } : undefined;
            },
            parseResult(value: unknown): DbQueryResult | undefined {
                if (typeof value !== "object" || value === null) return undefined;
                if (!("details" in value) || typeof value.details !== "object") return {};
                const details = value.details;
                if (details === null || !("rowCount" in details)) return { details: {} };
                return typeof details.rowCount === "number"
                    ? { details: { rowCount: details.rowCount } }
                    : { details: {} };
            },
            renderCall(args) {
                return call({ static: "DB Query" }, { body: text(args.sql) });
            },
            renderResult(result) {
                return output(`${result.details?.rowCount ?? 0} rows`, {
                    preview: { mode: "head" },
                });
            },
        } satisfies GlowupRenderer<DbQueryArgs, DbQueryResult>;
        const renderer = createThirdPartyToolRenderer("db_query", undefined, {
            [GLOWUP_RENDERING_PROPERTY]: rendering,
        });

        expect(hasGlowupRenderingAdapter({ [GLOWUP_RENDERING_PROPERTY]: rendering })).toBe(true);
        expect(
            renderer
                .renderCall({ sql: "select * from users" }, plainTheme, renderContext)
                .render(120)
                .join("\n"),
        ).toContain("DB Query select * from users");
        expect(
            renderer
                .renderResult(
                    { content: [], details: { rowCount: 3 } },
                    { expanded: false, isPartial: false },
                    plainTheme,
                    { ...renderContext, args: { sql: "select * from users" } },
                )
                .render(120)
                .join("\n"),
        ).toContain("3 rows");
    });

    it("renders the complete public protocol composition through an owner adapter", () => {
        const rendering = {
            version: 3,
            parseArgs(value: unknown) {
                return value;
            },
            parseResult(value: unknown) {
                return typeof value === "object" && value !== null ? value : undefined;
            },
            renderCall() {
                return call(
                    {
                        static: "Protocol Tool",
                        running: "Running Protocol Tool",
                        completed: "Ran Protocol Tool",
                    },
                    {
                        body: stack([
                            summary([
                                {
                                    label: { kind: "text", text: "Rows", tone: "muted" },
                                    value: {
                                        kind: "text",
                                        text: "3",
                                        tone: "success",
                                        bold: true,
                                    },
                                },
                            ]),
                            code("const value = 3;", {
                                title: { kind: "text", text: "query.ts", tone: "path" },
                                syntax: { language: "typescript", path: "query.ts" },
                                preview: { mode: "head", collapsedLines: 2, expandedLines: 20 },
                            }),
                            list(
                                [
                                    "first row",
                                    text({ kind: "text", text: "second row", tone: "accent" }),
                                ],
                                { collapsedLines: 2, expandable: false },
                            ),
                            empty(),
                        ]),
                    },
                );
            },
            renderResult() {
                return output(undefined, { noOutputLabel: "No additional output" });
            },
        } satisfies GlowupRenderer;
        const renderer = createThirdPartyToolRenderer(
            "protocol_tool",
            { labelMode: "lifecycle" },
            { [GLOWUP_RENDERING_PROPERTY]: rendering },
        );

        const callLines = renderer.renderCall({}, plainTheme, renderContext).render(100);
        const callText = compactRenderedText(callLines.join("\n"));
        const resultText = renderer
            .renderResult(
                { content: [] },
                { expanded: false, isPartial: false },
                plainTheme,
                renderContext,
            )
            .render(100)
            .join("\n");

        expect(callText).toContain("Ran Protocol Tool");
        expect(callText).toContain("Rows → 3");
        expect(callText).toContain("query.ts");
        expect(callText).toContain("const value = 3;");
        expect(callText).toContain("first row");
        expect(callText).toContain("second row");
        expect(resultText).toContain("No additional output");
        for (const width of [1, 20, 100]) {
            const lines = renderer.renderCall({}, plainTheme, renderContext).render(width);
            for (const line of lines) {
                expect(visibleWidth(stripAccentStyle(line))).toBeLessThanOrEqual(width);
            }
        }
    });

    it("falls back when an owner adapter returns a malformed node", () => {
        const renderer = createThirdPartyToolRenderer("custom_tool", undefined, {
            [GLOWUP_RENDERING_PROPERTY]: {
                version: 3,
                parseArgs(value: unknown) {
                    return value;
                },
                renderCall() {
                    return { kind: "text", text: 42 };
                },
            },
        });

        const rendered = renderer
            .renderCall({ action: "fallback" }, plainTheme, renderContext)
            .render(100)
            .join("\n");

        expect(rendered).toContain("custom_tool");
        expect(rendered).toContain('"action": "fallback"');
    });

    it("falls back when owner argument and result parsers fail", () => {
        const callRenderer = createThirdPartyToolRenderer("call_parser_tool", undefined, {
            [GLOWUP_RENDERING_PROPERTY]: {
                version: 3,
                parseArgs() {
                    throw new Error("invalid arguments");
                },
                renderCall() {
                    return call({ static: "Owner Call" });
                },
            },
        });
        const resultRenderer = createThirdPartyToolRenderer("result_parser_tool", undefined, {
            [GLOWUP_RENDERING_PROPERTY]: {
                version: 3,
                parseArgs(value: unknown) {
                    return value;
                },
                parseResult() {
                    throw new Error("invalid result");
                },
                renderResult() {
                    return output("owner output");
                },
            },
        });

        const callText = callRenderer
            .renderCall({ action: "fallback" }, plainTheme, renderContext)
            .render(100)
            .join("\n");
        const resultText = resultRenderer
            .renderResult(
                { content: [{ type: "text", text: "fallback output" }] },
                { expanded: false, isPartial: false },
                plainTheme,
                renderContext,
            )
            .render(100)
            .join("\n");

        expect(callText).toContain("call_parser_tool");
        expect(callText).not.toContain("Owner Call");
        expect(resultText).toContain("fallback output");
        expect(resultText).not.toContain("owner output");
    });

    it("falls back for owner node graphs beyond the protocol depth limit", () => {
        let nestedNode: unknown = text("leaf");
        for (let depth = 0; depth < 10; depth += 1) {
            nestedNode = { kind: "stack", children: [nestedNode] };
        }
        const renderer = createThirdPartyToolRenderer("deep_tool", undefined, {
            [GLOWUP_RENDERING_PROPERTY]: {
                version: 3,
                parseArgs(value: unknown) {
                    return value;
                },
                renderCall() {
                    return nestedNode;
                },
            },
        });

        const rendered = renderer
            .renderCall({ action: "bounded" }, plainTheme, renderContext)
            .render(100)
            .join("\n");

        expect(rendered).toContain("deep_tool");
        expect(rendered).toContain('"action": "bounded"');
        expect(rendered).not.toContain("leaf");
    });

    it("treats throwing rendering properties as absent", () => {
        const toolDefinition: Record<string, unknown> = {};
        Object.defineProperty(toolDefinition, GLOWUP_RENDERING_PROPERTY, {
            get() {
                throw new Error("property access failed");
            },
        });

        expect(hasGlowupRenderingAdapter(toolDefinition)).toBe(false);
        expect(
            shouldPreserveThirdPartyToolRenderer({
                toolName: "custom_tool",
                toolDefinition,
            }),
        ).toBe(false);
        expect(
            createThirdPartyToolRenderer("custom_tool", undefined, toolDefinition)
                .renderCall({}, plainTheme, renderContext)
                .render(100)
                .join("\n"),
        ).toContain("custom_tool");
    });

    it("uses adapter-specific lifecycle labels when configured", () => {
        const rendering = {
            version: 3,
            parseArgs(value: unknown) {
                return value;
            },
            renderCall() {
                return call({
                    static: "DB Query",
                    running: "Querying DB",
                    completed: "Queried DB",
                });
            },
        } satisfies GlowupRenderer;
        const renderer = createThirdPartyToolRenderer(
            "db_query",
            { labelMode: "lifecycle" },
            { [GLOWUP_RENDERING_PROPERTY]: rendering },
        );

        const active = renderer
            .renderCall({}, plainTheme, {
                ...renderContext,
                executionStarted: false,
                argsComplete: false,
                isPartial: true,
            })
            .render(80)
            .join("\n");
        const completed = renderer.renderCall({}, plainTheme, renderContext).render(80).join("\n");

        expect(active).toContain("Querying DB");
        expect(completed).toContain("Queried DB");
    });

    it("renders incomplete arguments only through the explicit partial slot", () => {
        const renderer = createThirdPartyToolRenderer("db_query", undefined, {
            glowupRendering: {
                version: 3,
                parseArgs(value: unknown) {
                    if (typeof value !== "object" || value === null || !("sql" in value)) {
                        return undefined;
                    }
                    return typeof value.sql === "string" ? { sql: value.sql } : undefined;
                },
                renderPartialCall() {
                    return call({ static: "DB Query", running: "Querying DB" });
                },
                renderCall(args: { readonly sql: string }) {
                    return call({ static: "DB Query" }, { body: text(args.sql) });
                },
            },
        });

        const partial = renderer
            .renderCall({}, plainTheme, {
                ...renderContext,
                argsComplete: false,
                isPartial: true,
            })
            .render(80)
            .join("\n");
        const complete = renderer
            .renderCall({ sql: "select 1" }, plainTheme, renderContext)
            .render(80)
            .join("\n");

        expect(partial).toContain("DB Query");
        expect(partial).not.toContain("db_query");
        expect(complete).toContain("DB Query select 1");
    });

    it("rejects adapters that omit their argument parser", () => {
        const definition = {
            glowupRendering: {
                version: 3,
                renderCall: () => call({ static: "Unsafe Owner" }),
            },
        };

        expect(hasGlowupRenderingAdapter(definition)).toBe(false);
        expect(
            createThirdPartyToolRenderer("unsafe_tool", undefined, definition)
                .renderCall({}, plainTheme, renderContext)
                .render(80)
                .join("\n"),
        ).toContain("unsafe_tool");
    });

    it("lets owner adapters replace transitional renderers one family at a time", () => {
        const renderer = createThirdPartyToolRenderer("agent_browser", undefined, {
            glowupRendering: {
                version: 3,
                parseArgs(value: unknown) {
                    return value;
                },
                renderCall: () => call({ static: "Owner Browser Renderer" }),
            },
        });

        const rendered = renderer
            .renderCall({ args: ["open", "https://example.com"] }, plainTheme, renderContext)
            .render(100)
            .join("\n");

        expect(rendered).toContain("Owner Browser Renderer");
        expect(rendered).not.toContain("Open https://example.com");
    });

    it("requires owner adapters for migrated Codex tool names", () => {
        const generic = createThirdPartyToolRenderer("web_run")
            .renderCall({ search_query: [{ q: "latest pi docs" }] }, plainTheme, renderContext)
            .render(100)
            .join("\n");
        const owned = createThirdPartyToolRenderer("web_run", undefined, {
            glowupRendering: {
                version: 3,
                parseArgs(value: unknown) {
                    return value;
                },
                renderCall: () => call({ static: "Owner Web Search" }),
            },
        })
            .renderCall({}, plainTheme, renderContext)
            .render(100)
            .join("\n");

        expect(generic).toContain("web_run");
        expect(generic).not.toContain("Web Search");
        expect(owned).toContain("Owner Web Search");
    });

    it("renders unknown tools as compact Glowup calls", () => {
        const renderer = createLifecycleRenderer("custom_tool");

        const lines = renderer
            .renderCall({ action: "run", value: 42 }, plainTheme, renderContext)
            .render(80);

        expect(lines.join("\n")).toContain("• Called custom_tool");
        expect(lines.join("\n")).toContain('"action": "run"');
    });

    it("keeps generic tool names stable in static mode", () => {
        const renderer = createThirdPartyToolRenderer("custom_tool", { labelMode: "static" });
        const active = renderer
            .renderCall({}, plainTheme, {
                ...renderContext,
                executionStarted: false,
                argsComplete: false,
                isPartial: true,
            })
            .render(80)
            .join("\n");
        const completed = renderer.renderCall({}, plainTheme, renderContext).render(80).join("\n");

        expect(active).toBe("");
        expect(completed).toContain("• custom_tool");
        expect(completed).not.toContain("Called");
    });

    it("updates generic tool verbs in lifecycle mode", () => {
        const renderer = createLifecycleRenderer("custom_tool");
        const active = renderer
            .renderCall({}, plainTheme, {
                ...renderContext,
                executionStarted: false,
                argsComplete: false,
                isPartial: true,
            })
            .render(80)
            .join("\n");
        const completed = renderer.renderCall({}, plainTheme, renderContext).render(80).join("\n");

        expect(active).toBe("");
        expect(completed).toContain("• Called custom_tool");
    });

    it("renders generic tools while their execution is running", () => {
        const renderer = createLifecycleRenderer("custom_tool");
        const running = renderer
            .renderCall({ action: "run" }, plainTheme, {
                ...renderContext,
                argsComplete: false,
                isPartial: true,
            })
            .render(80)
            .join("\n");

        expect(running).toContain("• Calling custom_tool");
        expect(running).toContain("action: run");
    });

    it("bounds huge generic third-party tool call argument previews", () => {
        const renderer = createThirdPartyToolRenderer("custom_tool");
        const args = {
            lines: Array.from({ length: 10_000 }, (_value, index) => `line ${index + 1}`),
        };

        const rendered = renderer
            .renderCall(args, plainTheme, { ...renderContext, expanded: true })
            .render(120)
            .join("\n");

        expect(rendered).toContain('"lines":');
        expect(rendered).toContain("… +9980 items");
        expect(rendered).not.toContain("line 10000");
    });

    it("redacts secret-like fields in generic argument previews", () => {
        const renderer = createThirdPartyToolRenderer("custom_tool");
        const rendered = renderer
            .renderCall(
                {
                    username: "alice",
                    password: "do-not-show",
                    nested: { accessToken: "also-do-not-show" },
                },
                plainTheme,
                { ...renderContext, expanded: true },
            )
            .render(120)
            .join("\n");

        expect(rendered).toContain("[redacted]");
        expect(rendered).not.toContain("do-not-show");
        expect(rendered).not.toContain("also-do-not-show");
    });

    it("suppresses internal artifact paths from generic detail summaries", () => {
        const renderer = createThirdPartyToolRenderer("custom_tool");
        const rendered = renderer
            .renderResult(
                {
                    content: [],
                    details: {
                        status: "complete",
                        artifactPath: "/tmp/private/artifact.json",
                        workspacePath: "/tmp/private/worktree",
                        transcriptFilePath: "/tmp/private/transcript.jsonl",
                    },
                },
                { expanded: false, isPartial: false },
                plainTheme,
                renderContext,
            )
            .render(100)
            .join("\n");

        expect(rendered).toContain("status: complete");
        expect(rendered).not.toContain("/tmp/private");
        expect(rendered).not.toContain("artifactPath");
        expect(rendered).not.toContain("workspacePath");
        expect(rendered).not.toContain("transcriptFilePath");
    });

    it("defers generic calls until their arguments are complete", () => {
        const renderer = createThirdPartyToolRenderer("custom_tool");
        const args = {
            prompt: "generate " + "token ".repeat(10_000),
            nested: { content: "do not traverse this".repeat(1_000) },
            files: Array.from({ length: 5_000 }, (_value, index) => `file-${index}`),
        };

        const rendered = renderer
            .renderCall(args, plainTheme, {
                ...renderContext,
                executionStarted: false,
                argsComplete: false,
                isPartial: true,
                expanded: true,
            })
            .render(120)
            .join("\n");

        expect(rendered).toBe("");
    });

    it("expands long third-party tool call arguments", () => {
        const renderer = createThirdPartyToolRenderer("custom_tool");
        const args = { lines: Array.from({ length: 10 }, (_value, index) => `line ${index + 1}`) };

        const collapsed = renderer
            .renderCall(args, plainTheme, renderContext)
            .render(80)
            .join("\n");
        const expanded = renderer
            .renderCall(args, plainTheme, { ...renderContext, expanded: true })
            .render(80)
            .join("\n");

        expect(collapsed).toContain("… +");
        expect(collapsed).toContain("to expand");
        expect(expanded).toContain("line 10");
        expect(expanded).not.toContain("… +");
    });

    it("uses browser-specific labels for agent browser calls", () => {
        const renderer = createThirdPartyToolRenderer("agent_browser");

        const lines = renderer
            .renderCall({ args: ["snapshot", "-i"] }, plainTheme, renderContext)
            .render(80);

        expect(lines[0]).toContain("Browser Snapshot");
        expect(lines.join("\n")).toContain("-i");
        expect(lines.join("\n")).not.toContain('"args"');
    });

    it("updates browser-specific verbs in lifecycle mode", () => {
        const renderer = createThirdPartyToolRenderer("agent_browser", {
            labelMode: "lifecycle",
        });
        const args = { args: ["snapshot", "-i"] };
        const active = renderer
            .renderCall(args, plainTheme, {
                ...renderContext,
                argsComplete: false,
                isPartial: true,
            })
            .render(100)
            .join("\n");
        const completed = renderer
            .renderCall(args, plainTheme, renderContext)
            .render(100)
            .join("\n");

        expect(active).toContain("Taking Browser Snapshot");
        expect(completed).toContain("Took Browser Snapshot");
    });

    it("uses shallow previews for partial agent browser job arguments", () => {
        const renderer = createThirdPartyToolRenderer("agent_browser");

        const rendered = renderer
            .renderCall(
                {
                    job: {
                        steps: Array.from({ length: 5_000 }, (_value, index) => ({
                            action: "fill",
                            text: `secretly large ${index}`,
                        })),
                    },
                },
                plainTheme,
                { ...renderContext, argsComplete: false, isPartial: true, expanded: true },
            )
            .render(120)
            .join("\n");

        expect(rendered).toContain("Browser Job");
        expect(rendered).toContain("5000 steps");
        expect(rendered).toContain("fill → fill");
        expect(rendered).not.toContain("secretly large");
        expect(rendered).not.toContain('"steps"');
    });

    it("summarizes every structured Agent Browser mode without raw argument JSON", () => {
        const renderer = createThirdPartyToolRenderer("agent_browser");
        const cases = [
            {
                args: { script: "async () => {\n  await browser({ args: ['open'] });\n}" },
                label: "Browser Script",
                body: "3 lines",
            },
            {
                args: {
                    semanticAction: {
                        action: "fill",
                        locator: "label",
                        value: "Email",
                        text: "secret@example.com",
                    },
                },
                label: "Browser Action",
                body: "18 characters",
                hidden: "secret@example.com",
            },
            {
                args: { qa: { url: "https://example.com", checkConsole: true } },
                label: "Browser QA",
                body: "check console",
            },
            {
                args: { electron: { action: "launch", appName: "Visual Studio Code" } },
                label: "Electron",
                body: "launch · Visual Studio Code",
            },
            {
                args: { sourceLookup: { componentName: "SettingsPanel" } },
                label: "Browser Source Lookup",
                body: "SettingsPanel",
            },
            {
                args: { networkSourceLookup: { requestId: "request-17" } },
                label: "Browser Network Lookup",
                body: "request-17",
            },
        ] as const;

        for (const testCase of cases) {
            const rendered = renderer
                .renderCall(testCase.args, plainTheme, renderContext)
                .render(100)
                .join("\n");
            expect(rendered).toContain(testCase.label);
            expect(rendered).toContain(testCase.body);
            expect(rendered).not.toContain('"semanticAction"');
            expect(rendered).not.toContain('"sourceLookup"');
            if ("hidden" in testCase) expect(rendered).not.toContain(testCase.hidden);
        }
    });

    it("uses singular item counts in partial argument previews", () => {
        const renderer = createThirdPartyToolRenderer("custom_tool");

        const rendered = renderer
            .renderCall({ questions: [{ question: "Only one" }] }, plainTheme, {
                ...renderContext,
                argsComplete: false,
                isPartial: true,
            })
            .render(100)
            .join("\n");

        expect(rendered).toContain("questions: 1 item");
        expect(rendered).not.toContain("questions: 1 items");
    });

    it("uses Chrome DevTools labels for MCP gateway calls", () => {
        const renderer = createThirdPartyToolRenderer("mcp");

        const lines = renderer
            .renderCall(
                { tool: "take_snapshot", args: '{"verbose":true}' },
                plainTheme,
                renderContext,
            )
            .render(80);

        expect(lines[0]).toContain("Browser Snapshot");
        expect(lines.join("\n")).toContain("verbose");
    });

    it("normalizes namespaced Chrome DevTools MCP tool names", () => {
        const renderer = createThirdPartyToolRenderer("mcp__chrome-devtools__take_snapshot");

        const lines = renderer.renderCall({}, plainTheme, renderContext).render(80);

        expect(lines[0]).toContain("Browser Snapshot");
    });

    it("provides semantic labels for the complete Chrome DevTools tool surface", () => {
        const labels = new Map([
            ["click", "Browser Click"],
            ["close_page", "Browser Close Page"],
            ["drag", "Browser Drag"],
            ["emulate", "Browser Emulate"],
            ["evaluate_script", "Browser Evaluate"],
            ["fill", "Browser Fill"],
            ["fill_form", "Browser Fill Form"],
            ["get_console_message", "Browser Console Message"],
            ["get_network_request", "Browser Network Request"],
            ["handle_dialog", "Browser Dialog"],
            ["hover", "Browser Hover"],
            ["lighthouse_audit", "Browser Lighthouse"],
            ["list_console_messages", "Browser Console"],
            ["list_network_requests", "Browser Network"],
            ["list_pages", "Browser Pages"],
            ["navigate_page", "Browser Navigate"],
            ["new_page", "Browser Open"],
            ["performance_analyze_insight", "Browser Performance Insight"],
            ["performance_start_trace", "Browser Start Trace"],
            ["performance_stop_trace", "Browser Stop Trace"],
            ["press_key", "Browser Key"],
            ["resize_page", "Browser Resize"],
            ["select_page", "Browser Select Page"],
            ["take_heapsnapshot", "Browser Heap Snapshot"],
            ["take_screenshot", "Browser Screenshot"],
            ["take_snapshot", "Browser Snapshot"],
            ["type_text", "Browser Type"],
            ["upload_file", "Browser Upload"],
            ["wait_for", "Browser Wait"],
        ]);

        for (const [command, label] of labels) {
            const renderer = createThirdPartyToolRenderer(`mcp__chrome-devtools__${command}`);
            const lines = renderer.renderCall({}, plainTheme, renderContext).render(100);
            expect(lines[0], command).toContain(label);
            for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
        }
    });

    it("summarizes MCP discovery, auth, status, and namespaced gateway calls", () => {
        const renderer = createThirdPartyToolRenderer("mcp");
        const cases = [
            [{ search: "browser" }, "MCP Search", "browser"],
            [{ describe: "chrome_devtools_click" }, "MCP Describe", "chrome_devtools_click"],
            [{ instructions: "chrome-devtools" }, "MCP Instructions", "chrome-devtools"],
            [{ connect: "chrome-devtools" }, "MCP Connect", "chrome-devtools"],
            [
                { action: "auth-start", server: "private-server" },
                "MCP Authenticate",
                "private-server",
            ],
            [{ server: "chrome-devtools" }, "MCP Status", "chrome-devtools"],
            [
                {
                    tool: "chrome_devtools_navigate_page",
                    args: { type: "url", url: "https://example.com" },
                },
                "Browser Navigate",
                "https://example.com",
            ],
        ] as const;

        for (const [args, label, body] of cases) {
            const rendered = renderer
                .renderCall(args, plainTheme, renderContext)
                .render(100)
                .join("\n");
            expect(rendered).toContain(label);
            expect(rendered).toContain(body);
            expect(rendered).not.toContain('"tool"');
        }
    });

    it("bounds expanded generic results while preserving useful head and tail evidence", () => {
        const renderer = createThirdPartyToolRenderer("custom_exec");
        const lines = renderer
            .renderResult(
                {
                    content: [
                        {
                            type: "text",
                            text: Array.from(
                                { length: 1_000 },
                                (_, index) => `record ${index + 1}`,
                            ).join("\n"),
                        },
                    ],
                },
                { expanded: true, isPartial: false },
                plainTheme,
                renderContext,
            )
            .render(100);

        expect(lines.length).toBeLessThanOrEqual(401);
        expect(lines.join("\n")).toContain("record 1");
        expect(lines.join("\n")).toContain("record 1000");
        expect(lines.join("\n")).toContain("expanded output bounded");
    });

    it("keeps partial result output compact unless expanded", () => {
        const renderer = createThirdPartyToolRenderer("custom_exec");

        const lines = renderer
            .renderResult(
                {
                    content: [
                        {
                            type: "text",
                            text: Array.from(
                                { length: 30 },
                                (_, index) => `line ${index + 1}`,
                            ).join("\n"),
                        },
                    ],
                },
                { expanded: false, isPartial: true },
                plainTheme,
                { ...renderContext, isPartial: true },
            )
            .render(100);

        expect(lines).toHaveLength(5);
        expect(lines.join("\n")).toContain("… +26 lines");
    });

    it("renders finalized plans without duplicating markdown arguments", () => {
        const renderer = createLifecycleRenderer("finalize_plan");

        const lines = renderer
            .renderCall(
                { markdown: "# Refactor Plan\n\n## Summary\nLong plan text" },
                plainTheme,
                renderContext,
            )
            .render(100);

        const rendered = lines.join("\n");
        expect(rendered).toContain("Finalized Plan");
        expect(rendered).not.toContain("Refactor Plan");
        expect(rendered).not.toContain("markdown");
        expect(rendered).not.toContain("expand");
    });

    it("hides successful finalized plan results", () => {
        const renderer = createThirdPartyToolRenderer("finalize_plan");

        const lines = renderer
            .renderResult(
                { content: [{ type: "text", text: "Plan rendered in the plan UI" }] },
                { expanded: false, isPartial: false },
                plainTheme,
                renderContext,
            )
            .render(100);

        expect(lines).toEqual([]);
    });

    it("renders ask_user_question calls as readable choices instead of JSON", () => {
        const renderer = createLifecycleRenderer("ask_user_question");

        const lines = renderer
            .renderCall(
                {
                    questions: [
                        {
                            header: "Candidates",
                            question:
                                "Which items should `/loti review` consider eligible for promotion into durable memory?",
                            options: [
                                {
                                    label: "Stable durable only (Recommended)",
                                    description: "Only promote candidates already marked stable.",
                                },
                                {
                                    label: "Stable and pending",
                                    description: "Include pending candidates in the review.",
                                },
                            ],
                        },
                    ],
                },
                plainTheme,
                renderContext,
            )
            .render(120);

        const rendered = lines.join("\n");
        expect(rendered).toContain("Asked User");
        expect(stripAccentStyle(rendered)).toContain("Candidates");
        expect(compactRenderedText(stripAccentStyle(rendered))).toContain(
            "Which items should `/loti review` consider eligible for promotion into durable memory?",
        );
        expect(rendered).toContain("Choose one:");
        expect(rendered).toContain("Stable durable only (Recommended)");
        expect(rendered).not.toContain('"questions"');
        expect(rendered).not.toContain('"description"');
    });

    it("renders ask_user_question answers without the boilerplate result sentence", () => {
        const renderer = createThirdPartyToolRenderer("ask_user_question");
        const args = {
            questions: [
                {
                    header: "Candidates",
                    question:
                        "Which items should `/loti review` consider eligible for promotion into durable memory?",
                    options: [
                        {
                            label: "Stable durable only (Recommended)",
                            description: "Only promote candidates already marked stable.",
                        },
                    ],
                },
            ],
        };

        const lines = renderer
            .renderResult(
                {
                    content: [
                        {
                            type: "text",
                            text: 'User has answered your questions: "Which items should `/loti review` consider eligible for promotion into durable memory?"="Stable durable only (Recommended)". You can now continue with the user\'s answers in mind.',
                        },
                    ],
                },
                { expanded: false, isPartial: false },
                plainTheme,
                { ...renderContext, args },
            )
            .render(120);

        const rendered = lines.join("\n");
        expect(stripAccentStyle(rendered)).toContain("Candidates → Stable durable only");
        expect(stripAccentStyle(rendered)).toContain(
            "Which items should `/loti review` consider eligible for promotion into durable memory?",
        );
        expect(rendered).not.toContain("User has answered your questions");
        expect(rendered).not.toContain("You can now continue");
    });

    it("parses env opt-out tool names", () => {
        expect(parsePreservedThirdPartyToolNames("mcp, rich_tool ,, web_run ")).toEqual([
            "mcp",
            "rich_tool",
            "web_run",
        ]);
    });

    it("preserves tools by matcher or explicit tool preference", () => {
        expect(
            shouldPreserveThirdPartyToolRenderer({
                toolName: "rich_tool",
                toolDefinition: {},
                renderingOptions: { preserveTools: ["rich_tool"] },
            }),
        ).toBe(true);

        expect(
            shouldPreserveThirdPartyToolRenderer({
                toolName: "another_tool",
                toolDefinition: { [GLOWUP_RENDERING_PROPERTY]: "preserve" },
            }),
        ).toBe(true);
    });
});
