import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import { queryObjects } from "node:v8";
import { stripVTControlCharacters } from "node:util";
import { Markdown, type Component } from "@earendil-works/pi-tui";
import { Lexer } from "marked";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { configureMarkdownSyntaxPatch } from "../../../src/pi/patches/markdown-syntax.ts";
import * as syntax from "../../../src/rendering/syntax/highlighter.ts";
import { createMarkdownRows } from "../../../src/tools/protocol/rendered-content.ts";
import { renderProtocolNode } from "../../../src/tools/protocol/node-renderer.ts";
import {
    call,
    list,
    stack,
    text,
    output,
    registerGlowupStreamingPolicy,
    type GlowupNode,
} from "../../../src/tools/protocol/contract.ts";
import type {
    TokenizeInitialization,
    TokenizeRequest,
} from "../../../src/rendering/syntax/tokenize-worker.ts";
import type { ThirdPartyToolRenderContext } from "../../../src/tools/types.ts";
import { createPlainTheme } from "../../support/plain-theme.ts";

const theme = createPlainTheme();
const context: ThirdPartyToolRenderContext = {
    toolCallId: "markdown-cache",
    args: {},
    argsComplete: true,
    executionStarted: true,
    isPartial: false,
    isError: false,
    expanded: true,
    showImages: false,
};

const report =
    "# Findings\n\n" +
    Array.from({ length: 1000 }, (_, i) => `- **Finding ${i}**: inspect \`file-${i}.ts\`.`).join(
        "\n",
    );

const node = (source = report) =>
    output(source, { format: "markdown", preview: { expandedLines: 2000 } });

const render = (source = report, overrides: Partial<ThirdPartyToolRenderContext> = {}) =>
    renderProtocolNode(node(source), theme, { ...context, ...overrides }, "static");

const largeFence =
    "```javascript\n" +
    Array.from(
        { length: 400 },
        (_, i) => `const finding${i} = ${i}; // retained report syntax`,
    ).join("\n") +
    "\n```";

const nested = (items: readonly GlowupNode[]) =>
    call(
        { static: "Report" },
        {
            body: stack([list(items, { expandedLines: 2000 }, "tree")]),
            preview: { expandedLines: 2000 },
        },
    );

class CountingSyntaxWorker extends Worker {
    submissions = 0;

    constructor(url: URL) {
        super(url, { execArgv: [] });
    }

    override postMessage(message: TokenizeInitialization | TokenizeRequest): void {
        if ("operation" in message && message.operation === "highlight") this.submissions += 1;
        super.postMessage(message);
    }
}

// Real public Worker boundary, but deterministic readiness/completion for stale jobs.
class HeldSyntaxWorker extends Worker {
    readonly requests: TokenizeRequest[] = [];

    constructor() {
        super('require("node:worker_threads").parentPort.on("message", () => {});', {
            eval: true,
            execArgv: [],
        });
    }

    override postMessage(message: TokenizeInitialization | TokenizeRequest): void {
        if ("type" in message)
            queueMicrotask(() => {
                this.emit("message", { type: "ready" });
            });
        else this.requests.push(message);
    }

    complete(): void {
        const request = this.requests.at(-1);
        if (request === undefined) throw new Error("Missing held syntax request");

        this.emit("message", {
            id: request.id,
            lines: request.code.split("\n").map((row) => `\u001b[38;2;1;2;3m${row}\u001b[39m`),
        });
    }
}

describe("protocol Markdown ownership", () => {
    it("reuses native rows/tokens for unchanged large renders and same-slot snapshots", () => {
        const lexer = vi.spyOn(Lexer, "lex");
        const native = vi.spyOn(Markdown.prototype, "render");
        onTestFinished(() => {
            vi.restoreAllMocks();
        });
        const first = render();
        const rows = first.render(110);
        expect(rows.length).toBeGreaterThan(300);
        expect(lexer).toHaveBeenCalledTimes(1);

        for (let i = 0; i < 40; i += 1) expect(first.render(110)).toEqual(rows);

        // The enclosing makeComponent deliberately does not retain >300 rows.
        expect(native).toHaveBeenCalledTimes(41);
        expect(lexer).toHaveBeenCalledTimes(1);
        const next = render(report, { lastComponent: first });
        expect(next.render(110)).toEqual(rows);
        expect(lexer).toHaveBeenCalledTimes(1);
        const changed = render(report.replace("Findings", "Changed"), { lastComponent: next });
        expect(changed.render(110).join("\n")).toContain("Changed");
        expect(lexer).toHaveBeenCalledTimes(2);
        expect(changed.render(40)).toEqual(
            render(report.replace("Findings", "Changed")).render(40),
        );
        const independent = render(report, { lastComponent: changed, toolCallId: "other" });
        expect(independent.render(110).join("\n")).toContain("Findings");
        const bounded = renderProtocolNode(
            output(report, { format: "markdown" }),
            theme,
            context,
            "static",
        );
        expect(bounded.render(110)).toHaveLength(501);
    });

    it("invalidates native colors on theme changes, including replacement theme objects", () => {
        let color = "36";
        const style = {
            fg: (_token: string, value: string) => `\u001b[${color}m${value}\u001b[39m`,
            bold: (value: string) => value,
        };
        const first = renderProtocolNode(node(), style, context, "static");
        expect(first.render(100).join("\n")).toContain("\u001b[36m\u001b[4mFindings");
        color = "35";
        first.invalidate();
        expect(first.render(100).join("\n")).toContain("\u001b[35m\u001b[4mFindings");
        const next = render(report, { lastComponent: first });
        expect(next.render(100).join("\n")).not.toContain("\u001b[35m");
    });

    it.each([false, true])(
        "refreshes short cached fences after syntax changes (native patch %s)",
        async (patched) => {
            configureMarkdownSyntaxPatch(patched);
            onTestFinished(async () => {
                configureMarkdownSyntaxPatch(false);
                await syntax.disposeSyntaxHighlighting();
            });
            const invalidate = vi.fn<() => void>();
            const first = render("```javascript\nconst marker = 1;\n```", { invalidate });
            first.render(80);
            await syntax.initializeSyntaxHighlighting(
                { PI_GLOWUP_SYNTAX_THEME: resolve("themes/darker-modern-theme.json") },
                { preloadLanguages: ["javascript"] },
            );
            first.render(80);
            await syntax.settleSyntaxHighlights();
            expect(first.render(80).join("\n")).toContain("38;2");
            await syntax.disposeSyntaxHighlighting();
            expect(first.render(80).join("\n")).not.toContain("38;2");
        },
    );

    it("quiesces large native fences through whole-tree invalidation and descendant rebuilds", async () => {
        configureMarkdownSyntaxPatch(true);
        onTestFinished(async () => {
            configureMarkdownSyntaxPatch(false);
            vi.restoreAllMocks();
            await syntax.disposeSyntaxHighlighting();
        });
        const workers: CountingSyntaxWorker[] = [];
        await syntax.initializeSyntaxHighlighting(
            { PI_GLOWUP_SYNTAX_THEME: resolve("themes/darker-modern-theme.json") },
            {
                preloadLanguages: ["javascript"],
                createWorker: (url) => {
                    const worker = new CountingSyntaxWorker(url);
                    workers.push(worker);
                    return worker;
                },
            },
        );
        const native = vi.spyOn(Markdown.prototype, "render");
        const submissions = () => workers.reduce((count, worker) => count + worker.submissions, 0);
        expect(Buffer.byteLength(largeFence)).toBeGreaterThan(8 * 1024);
        let current: Component | undefined;
        let repaintRequested = false;

        // Same order as renderSlotInvalidation: invalidate the whole rendered tree,
        // rebuilding stack/list descendants, then request a later presented render.
        const invalidateHost = vi.fn(() => {
            current?.invalidate();
            repaintRequested = true;
        });
        current = renderProtocolNode(
            nested([node(largeFence)]),
            theme,
            { ...context, invalidate: invalidateHost },
            "static",
        );
        current.render(100);
        const settle = async () => {
            for (let pass = 0; pass < 8; pass += 1) {
                await syntax.settleSyntaxHighlights();

                if (!repaintRequested) return;

                repaintRequested = false;
                current?.render(100);
            }

            throw new Error("Native syntax repaint did not quiesce");
        };
        await settle();
        expect(current.render(100).join("\n")).toContain("38;2");
        expect(submissions()).toBe(1);
        expect(invalidateHost).toHaveBeenCalledTimes(1);

        for (let index = 0; index < 20; index += 1) {
            current.render(100);
            invalidateHost();
            current.render(100);
            await settle();
        }

        expect(native.mock.calls.length).toBeGreaterThan(40);
        expect(new Set(native.mock.contexts).size).toBe(1);
        expect(submissions()).toBe(1);

        // Only the twenty deliberately requested invalidations, not syntax churn.
        expect(invalidateHost).toHaveBeenCalledTimes(21);
        expect(syntax.syntaxHighlightCacheStats().entries).toBe(0);
    });

    it.each(["replacement", "removal"])(
        "ignores obsolete native fence completion after true %s",
        async (change) => {
            configureMarkdownSyntaxPatch(true);
            const workers: HeldSyntaxWorker[] = [];
            onTestFinished(async () => {
                configureMarkdownSyntaxPatch(false);
                await syntax.disposeSyntaxHighlighting();
            });
            await syntax.initializeSyntaxHighlighting(
                { PI_GLOWUP_SYNTAX_THEME: resolve("themes/darker-modern-theme.json") },
                {
                    preloadLanguages: ["javascript"],
                    createWorker: () => {
                        const worker = new HeldSyntaxWorker();
                        workers.push(worker);
                        return worker;
                    },
                },
            );
            let current: Component | undefined;
            const invalidateHost = vi.fn(() => current?.invalidate());
            current = renderProtocolNode(
                nested([node(largeFence)]),
                theme,
                { ...context, invalidate: invalidateHost },
                "static",
            );
            current.render(100);

            for (let pass = 0; pass < 16; pass += 1) await Promise.resolve();
            const worker = workers[0];
            if (worker === undefined) throw new Error("Missing native fence worker");

            expect(worker.requests).toHaveLength(1);
            let items: readonly GlowupNode[] = [];
            if (change === "replacement") items = [text("Replacement")];

            current = renderProtocolNode(
                nested(items),
                theme,
                { ...context, invalidate: invalidateHost, lastComponent: current },
                "static",
            );
            const rows = current.render(100);
            expect(rows.join("\n")).not.toContain("finding");
            worker.complete();
            await syntax.settleSyntaxHighlights();

            for (let pass = 0; pass < 5; pass += 1) {
                current.invalidate();
                expect(current.render(100)).toEqual(rows);
                await syntax.settleSyntaxHighlights();
            }

            expect(invalidateHost).not.toHaveBeenCalled();
            expect(worker.requests).toHaveLength(1);
        },
    );

    it("observes only visible streamed source and cancels it on replacement", () => {
        const observe = vi.spyOn(syntax, "observeSyntaxHighlightSource");
        const abort = vi.spyOn(AbortController.prototype, "abort");
        onTestFinished(() => {
            vi.restoreAllMocks();
        });
        let visible = "# Visible\n\n" + report;
        const policy = registerGlowupStreamingPolicy({
            present: () => visible,
            settled: async () => {},
        });
        onTestFinished(() => policy.dispose());
        const streamed = output("raw pending source", {
            format: "markdown",
            streaming: { kind: "markdown" },
            preview: { expandedLines: 2000 },
        });
        const first = renderProtocolNode(
            streamed,
            theme,
            { ...context, invalidate: () => {} },
            "static",
        );
        first.render(80);
        const owner = observe.mock.calls[0]?.[1];
        if (owner === undefined) throw new Error("Missing syntax owner");

        const current = syntax.observeSyntaxHighlightSource(visible, owner);

        for (let i = 0; i < 3; i += 1) first.render(80);
        expect(current()).toBe(true);
        expect(abort).not.toHaveBeenCalled();
        expect(observe.mock.calls.every(([source]) => source === visible)).toBe(true);
        visible = "# Replacement";
        first.invalidate();
        expect(stripVTControlCharacters(first.render(80).join("\n"))).toContain("Replacement");
        expect(current()).toBe(false);
        expect(abort).toHaveBeenCalledTimes(1);
    });

    it("updates source to empty without retaining obsolete rendered rows", () => {
        const rows = createMarkdownRows(theme, undefined);
        expect(rows.render("# Before", 80).join("\n")).toContain("Before");
        expect(rows.render("", 80)).toEqual([]);
        expect(rows.render("# After", 80).join("\n")).not.toContain("Before");
    });

    it("does not retain previous snapshots or native parsers when the live component is released", () => {
        class PreviousSnapshot implements Component {
            render() {
                return ["obsolete"];
            }

            invalidate() {}
        }

        class SnapshotArguments {
            readonly [key: string]: string;

            readonly marker = "snapshot";
        }

        const baseline = queryObjects(Markdown, { format: "count" });

        function latest(): Component {
            let current: Component = new PreviousSnapshot();
            for (let i = 0; i < 100; i += 1) {
                current = render(`# Snapshot ${i}`, {
                    lastComponent: current,
                    args: new SnapshotArguments(),
                    invalidate: () => {},
                });
                current.render(80);
            }

            return current;
        }

        let current: Component | undefined = latest();
        expect(queryObjects(PreviousSnapshot, { format: "count" })).toBe(0);
        expect(queryObjects(SnapshotArguments, { format: "count" })).toBe(1);
        expect(queryObjects(Markdown, { format: "count" })).toBe(baseline + 1);
        expect(current.render(80).join("\n")).toContain("Snapshot 99");
        current = undefined;
        expect(queryObjects(SnapshotArguments, { format: "count" })).toBe(0);
        expect(queryObjects(Markdown, { format: "count" })).toBe(baseline);
    });
});
