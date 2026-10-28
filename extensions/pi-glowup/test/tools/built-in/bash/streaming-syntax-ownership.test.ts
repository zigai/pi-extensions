import type { Component } from "@earendil-works/pi-tui";
import { Theme } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { format } from "oxfmt";
import Type from "typebox";
import { Value } from "typebox/value";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createNativeBashFeature } from "../../../../src/tools/built-in/bash/preview.ts";
import type { BuiltInRenderContext } from "../../../../src/tools/built-in/context.ts";
import {
    disposeSyntaxHighlighting,
    initializeSyntaxHighlighting,
    settleSyntaxHighlights,
} from "../../../../src/rendering/syntax/highlighter.ts";
import { TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS } from "../../../support/theme-colors.ts";
import { configureRenderDiagnostics } from "../../../../src/diagnostics/render-events.ts";
import type { DebugLogFields } from "../../../../src/diagnostics/logger.ts";

const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");

// Large enough to bypass the shared per-source syntax cache. The live tool row
// must retain its own colors when Pi rebuilds it after asynchronous completion.
const source = Array.from(
    { length: 180 },
    (_value, index) => `const value${index} = formatValue("syntax_${index}", ${index});`,
).join("\n");

describe("streaming Bash syntax ownership", () => {
    afterEach(async () => {
        await disposeSyntaxHighlighting();
    });

    it("observes the selected formatted output against each full command revision", async () => {
        const events: DebugLogFields[] = [];
        configureRenderDiagnostics((event, fields) => {
            if (event === "syntax_component_render") events.push(fields());
        });

        onTestFinished(() => configureRenderDiagnostics(undefined));
        const formatter = async ({ code }: { readonly code: string }) =>
            (await format("source.js", code)).code;

        const feature = createNativeBashFeature(() => formatter);
        onTestFinished(() => feature.clear());
        const commands = [
            "node -e 'const value=1'",
            "node -e 'const value=2'",
            "node -e 'const value=1'",
        ];

        let previous: Component | undefined;
        const observations: Array<{ owner: string; revision: number }> = [];
        for (const command of commands) {
            const toolCallId = "format-owner";
            feature.schedule({
                toolCallId,
                command,
                formatter,
                signal: undefined,
                completed: true,
                isCurrent: () => true,
                invalidate: () => {},
            });
            await feature.settled();
            const context = {
                args: { command },
                toolCallId,
                cwd: "/work",
                lastComponent: previous,
                state: {},
                executionStarted: true,
                argsComplete: true,
                isPartial: false,
                expanded: true,
                showImages: false,
                isError: false,
                durationMs: undefined,
                outputPad: 1,
                invalidate: () => {},
            } satisfies BuiltInRenderContext;
            previous = feature.renderBashCall(
                { command },
                theme,
                context,
                () => 8,
                () => false,
                () => "preserve",
                () => "trailing",
            );
            previous.render(120);
            await feature.settled();
            previous = feature.renderBashCall(
                { command },
                theme,
                { ...context, lastComponent: previous },
                () => 8,
                () => false,
                () => "preserve",
                () => "trailing",
            );
            const displayed = previous.render(120).map(stripVTControlCharacters).join("\n");
            let raw = "const value=1";
            let formattedText = "const value = 1;";
            if (command.includes("=2")) {
                raw = "const value=2";
                formattedText = "const value = 2;";
            }

            expect(displayed).toContain(formattedText);
            const sourceHash = createHash("sha256").update(command).digest("hex").slice(0, 16);
            const schema = Type.Object({
                ownerId: Type.String(),
                revision: Type.Number(),
                formats: Type.Array(
                    Type.Object({
                        ownerId: Type.Union([Type.String(), Type.Null()]),
                        revision: Type.Number(),
                        sourceHash: Type.String(),
                        state: Type.String(),
                        outputHash: Type.Optional(Type.String()),
                    }),
                ),
            });
            const parsed = [...events]
                .reverse()
                .map((entry) => Value.Parse(schema, entry))
                .find((entry) =>
                    entry.formats.some(
                        (item) => item.sourceHash === sourceHash && item.state === "ready",
                    ),
                );
            if (parsed === undefined) throw new Error("Missing ready component render");

            const observed = parsed.formats.find(
                (item) => item.sourceHash === sourceHash && item.state === "ready",
            );
            expect(observed?.ownerId).toBe(parsed.ownerId);
            expect(observed?.revision).toBe(parsed.revision);
            const formatted = await formatter({ code: raw });
            expect(observed?.outputHash).toBe(
                createHash("sha256").update(formatted).digest("hex").slice(0, 16),
            );

            observations.push({ owner: parsed.ownerId, revision: parsed.revision });
        }

        expect(observations.map(({ owner }) => owner)).toEqual([
            observations[0]?.owner,
            observations[0]?.owner,
            observations[0]?.owner,
        ]);

        expect(new Set(observations.map(({ revision }) => revision)).size).toBe(3);
    });

    it("reports pending until the selected formatted output is rendered", async () => {
        const events: DebugLogFields[] = [];
        configureRenderDiagnostics((event, fields) => {
            if (event === "syntax_component_render") events.push(fields());
        });

        onTestFinished(() => configureRenderDiagnostics(undefined));
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const formatter = async ({ code }: { readonly code: string }) => {
            await gate;
            return (await format("source.js", code)).code;
        };

        const feature = createNativeBashFeature(() => formatter);
        onTestFinished(() => {
            release();
            feature.clear();
        });
        const command = `node -e 'const value=1'`;
        const toolCallId = "pending-format";
        feature.schedule({
            toolCallId,
            command,
            formatter,
            signal: undefined,
            completed: true,
            isCurrent: () => true,
            invalidate: () => {},
        });
        let previous: Component | undefined;
        const render = () => {
            const context = {
                args: { command },
                toolCallId,
                cwd: "/work",
                lastComponent: previous,
                state: {},
                executionStarted: true,
                argsComplete: true,
                isPartial: false,
                expanded: true,
                showImages: false,
                isError: false,
                durationMs: undefined,
                outputPad: 1,
                invalidate: () => {},
            } satisfies BuiltInRenderContext;
            previous = feature.renderBashCall(
                { command },
                theme,
                context,
                () => 8,
                () => false,
                () => "preserve",
                () => "trailing",
            );

            return previous.render(100).map(stripVTControlCharacters).join("\n");
        };
        expect(render()).toContain("const value=1");
        const before = JSON.stringify(events);
        expect(before).toContain('"state":"pending"');
        expect(before).not.toContain('"state":"ready"');
        release();
        await feature.settled();
        expect(render()).toContain("const value = 1;");
        await feature.settled();
        expect(render()).toContain("const value = 1;");
        expect(JSON.stringify(events)).toContain('"state":"ready"');
    });

    it("notifies a synchronous host after the selected formatter result becomes ready", async () => {
        const events: DebugLogFields[] = [];
        configureRenderDiagnostics((event, fields) => {
            if (event === "syntax_component_render") events.push(fields());
        });

        onTestFinished(() => configureRenderDiagnostics(undefined));
        const formatter = async ({ code }: { readonly code: string }) =>
            (await format("source.js", code)).code;

        const feature = createNativeBashFeature(() => formatter);
        onTestFinished(() => feature.clear());
        const command = `node -e 'const value=1'`;
        const toolCallId = "sync-host";
        let previous: Component | undefined;
        const render = () => {
            const context = {
                args: { command },
                toolCallId,
                cwd: "/work",
                lastComponent: previous,
                state: {},
                executionStarted: true,
                argsComplete: true,
                isPartial: false,
                expanded: true,
                showImages: false,
                isError: false,
                durationMs: undefined,
                outputPad: 1,
                invalidate: render,
            } satisfies BuiltInRenderContext;
            previous = feature.renderBashCall(
                { command },
                theme,
                context,
                () => 8,
                () => false,
                () => "preserve",
                () => "trailing",
            );
            previous.render(100);
        };
        render();
        feature.schedule({
            toolCallId,
            command,
            formatter,
            signal: undefined,
            completed: true,
            isCurrent: () => true,
            invalidate: () => {},
        });
        await feature.settled();
        await feature.settled();
        expect(JSON.stringify(events)).toContain('"state":"ready"');
    });

    it("does not report a prior width's formatted output as ready after resizing", async () => {
        const events: DebugLogFields[] = [];
        configureRenderDiagnostics((event, fields) => {
            if (event === "syntax_component_render") events.push(fields());
        });

        onTestFinished(() => configureRenderDiagnostics(undefined));
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const formatter = async ({
            code,
            targetWidth,
        }: {
            readonly code: string;
            readonly targetWidth?: number;
        }) => {
            if (targetWidth !== undefined && targetWidth < 70) await gate;
            return (await format("source.js", code)).code;
        };

        const feature = createNativeBashFeature(() => formatter);
        onTestFinished(() => {
            release();
            feature.clear();
        });
        const command = `node -e 'const value=1'`;
        const toolCallId = "format-width";
        feature.schedule({
            toolCallId,
            command,
            formatter,
            signal: undefined,
            completed: true,
            isCurrent: () => true,
            invalidate: () => {},
        });
        await feature.settled();
        let previous: Component | undefined;
        const render = (width: number) => {
            const context = {
                args: { command },
                toolCallId,
                cwd: "/work",
                lastComponent: previous,
                state: {},
                executionStarted: true,
                argsComplete: true,
                isPartial: false,
                expanded: true,
                showImages: false,
                isError: false,
                durationMs: undefined,
                outputPad: 1,
                invalidate: () => {},
            } satisfies BuiltInRenderContext;
            previous = feature.renderBashCall(
                { command },
                theme,
                context,
                () => 8,
                () => false,
                () => "preserve",
                () => "trailing",
            );
            previous.render(width);
        };
        render(100);
        await feature.settled();
        render(100);
        expect(JSON.stringify(events.at(-1))).toContain('"state":"ready"');
        render(40);
        expect(JSON.stringify(events.at(-1))).not.toContain('"state":"ready"');
        release();
        await feature.settled();
        render(40);
        expect(JSON.stringify(events.at(-1))).toContain('"state":"ready"');
    });

    it("keeps streamed format state unknown and embedded owners separate across resize", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
        const events: DebugLogFields[] = [];
        configureRenderDiagnostics((event, fields) => {
            if (event === "syntax_component_render") events.push(fields());
        });

        onTestFinished(() => configureRenderDiagnostics(undefined));
        const feature = createNativeBashFeature();
        onTestFinished(() => feature.clear());
        const command = `node -e 'const alpha=1'; node -e 'const beta=2'`;
        let previous: Component | undefined;
        const context = {
            args: { command },
            toolCallId: "independent-owners",
            cwd: "/work",
            state: {},
            executionStarted: true,
            argsComplete: true,
            isPartial: false,
            expanded: true,
            showImages: false,
            isError: false,
            durationMs: undefined,
            outputPad: 1,
            invalidate: () => {},
        } satisfies Omit<BuiltInRenderContext, "lastComponent">;
        const render = (width: number) => {
            previous = feature.renderBashCall(
                { command },
                theme,
                { ...context, lastComponent: previous },
                () => 8,
                () => false,
                () => "preserve",
                () => "trailing",
                ({ source: code }) => code,
            );
            previous.render(width);
        };
        render(120);
        await feature.settled();
        render(120);
        await settleSyntaxHighlights();
        const read = () =>
            Value.Parse(
                Type.Object({
                    ownerId: Type.String(),
                    revision: Type.Number(),
                    formats: Type.Array(Type.Unknown()),
                    requests: Type.Array(
                        Type.Object({ ownerId: Type.Union([Type.String(), Type.Null()]) }),
                    ),
                }),
                events.at(-1),
            );
        render(120);
        const wide = read();
        render(80);
        const narrow = read();
        expect(wide.formats).toEqual([]);
        expect(narrow.formats).toEqual([]);
        expect(narrow.ownerId).toBe(wide.ownerId);
        expect(narrow.revision).toBe(wide.revision);
        const childOwners = (item: typeof wide) =>
            new Set(
                item.requests
                    .map((request) => request.ownerId)
                    .filter((owner) => owner !== null && owner !== item.ownerId),
            );
        expect(childOwners(wide).size).toBeGreaterThanOrEqual(2);
        expect(childOwners(narrow)).toEqual(childOwners(wide));
    });

    it("retains independent embedded programs across width changes", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
        const feature = createNativeBashFeature();
        onTestFinished(() => feature.clear());
        const first = source.replaceAll("syntax_", "alpha_");
        const second = source.replaceAll("syntax_", "beta_");
        const command = `node -e '${first}'; node -e '${second}'`;
        const invalidate = vi.fn<() => void>();
        let previous: Component | undefined;
        const render = (width: number) => {
            const context = {
                args: { command },
                toolCallId: "independent-resize",
                cwd: "/work",
                lastComponent: previous,
                state: {},
                executionStarted: true,
                argsComplete: true,
                isPartial: false,
                expanded: true,
                showImages: false,
                isError: false,
                durationMs: undefined,
                outputPad: 1,
                invalidate,
            } satisfies BuiltInRenderContext;
            previous = feature.renderBashCall(
                { command },
                theme,
                context,
                () => 8,
                () => false,
                () => "preserve",
                () => "trailing",
                ({ source: code }) => code,
            );

            return previous.render(width);
        };
        render(120);
        await feature.settled();
        render(120);
        await settleSyntaxHighlights();
        previous?.invalidate();
        const wide = render(120).map(stripVTControlCharacters).join("\n");
        const narrow = render(80).map(stripVTControlCharacters).join("\n");
        expect(wide).toContain("alpha_0");
        expect(wide).toContain("beta_0");
        expect(narrow).toContain("alpha_0");
        expect(narrow).toContain("beta_0");
        await settleSyntaxHighlights();
        expect(render(120).map(stripVTControlCharacters).join("\n")).toBe(wide);
    });

    it("does not adopt a stale program after an A to B to A source change", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
        const feature = createNativeBashFeature();
        onTestFinished(() => feature.clear());
        const first = `node -e '${source.replaceAll("syntax_", "alpha_")}'`;
        const second = `node -e '${source.replaceAll("syntax_", "beta_")}'`;
        const invalidate = vi.fn<() => void>();
        let previous: Component | undefined;
        const render = (command: string) => {
            const context = {
                args: { command },
                toolCallId: "source-revisions",
                cwd: "/work",
                lastComponent: previous,
                state: {},
                executionStarted: true,
                argsComplete: true,
                isPartial: false,
                expanded: true,
                showImages: false,
                isError: false,
                durationMs: undefined,
                outputPad: 1,
                invalidate,
            } satisfies BuiltInRenderContext;
            previous = feature.renderBashCall(
                { command },
                theme,
                context,
                () => 8,
                () => false,
                () => "preserve",
                () => "trailing",
                ({ source: code }) => code,
            );

            return previous.render(120);
        };
        render(first);
        render(second);
        render(first);
        await feature.settled();
        render(first);
        await settleSyntaxHighlights();
        previous?.invalidate();
        const displayed = render(first).map(stripVTControlCharacters).join("\n");
        expect(displayed).toContain("alpha_0");
        expect(displayed).not.toContain("beta_0");
    });

    it("does not invalidate a reset feature when a syntax job finishes late", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
        const feature = createNativeBashFeature();
        const command = `node --input-type=module <<'JS'\n${source}\nJS`;
        const invalidate = vi.fn<() => void>();
        const context = {
            args: { command },
            toolCallId: "reset-syntax",
            cwd: "/work",
            lastComponent: undefined,
            state: {},
            executionStarted: true,
            argsComplete: true,
            isPartial: false,
            expanded: true,
            showImages: false,
            isError: false,
            durationMs: undefined,
            outputPad: 1,
            invalidate,
        } satisfies BuiltInRenderContext;
        const show = () =>
            feature.renderBashCall(
                { command },
                theme,
                context,
                () => 8,
                () => false,
                () => "auto",
                () => "trailing",
                ({ source: code }) => code,
            );
        show().render(120);
        await feature.settled();
        show().render(120);
        const before = invalidate.mock.calls.length;
        feature.clear();
        await settleSyntaxHighlights();
        expect(invalidate).toHaveBeenCalledTimes(before);
    });

    it("does not flash plain code or restart highlighting when a streamed tool row rebuilds", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
        expect(Buffer.byteLength(source)).toBeGreaterThan(8 * 1024);
        const feature = createNativeBashFeature();
        onTestFinished(() => feature.clear());
        const command = `node --input-type=module <<'JS'\n${source}\nJS`;
        const invalidate = vi.fn<() => void>();
        let previous: Component | undefined;
        const redraw = () => {
            const context = {
                args: { command },
                toolCallId: "streamed-syntax",
                cwd: "/work",
                lastComponent: previous,
                state: {},
                executionStarted: true,
                argsComplete: true,
                isPartial: false,
                expanded: true,
                showImages: false,
                isError: false,
                durationMs: undefined,
                outputPad: 1,
                invalidate,
            } satisfies BuiltInRenderContext;
            previous = feature.renderBashCall(
                { command },
                theme,
                context,
                () => 8,
                () => false,
                () => "auto",
                () => "trailing",
                ({ source: code }) => code,
            );

            return previous.render(120);
        };

        redraw();
        await feature.settled();
        const cold = redraw();
        await settleSyntaxHighlights();
        expect(invalidate).toHaveBeenCalled();
        previous?.invalidate();
        const colored = previous?.render(120);
        expect(colored).toBeDefined();
        expect(colored).not.toEqual(cold);
        const completions = invalidate.mock.calls.length;
        for (let revision = 0; revision < 4; revision += 1) {
            expect(redraw()).toEqual(colored);
            await settleSyntaxHighlights();
            expect(invalidate).toHaveBeenCalledTimes(completions);
        }

        expect(colored?.map(stripVTControlCharacters)).toEqual(cold.map(stripVTControlCharacters));
    });
});
