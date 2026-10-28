import { afterEach, describe, expect, it } from "vitest";
import Type from "typebox";
import { Value } from "typebox/value";
import { createProtocolRenderer } from "../../../src/tools/protocol/renderer.ts";
import { createGenericRenderer } from "../../../src/tools/call-rendering.ts";
import { compactPresentation, outlinePresentation } from "../../../src/rendering/presentation.ts";
import { selectGlowupPresentation } from "../../../src/rendering/presentation-registry.ts";
import { createThirdPartyToolRenderer } from "../../../src/tools/renderers.ts";
import { registerGlowupToolRenderer } from "../../../src/presentation.ts";
import {
    call,
    code,
    output,
    stack,
    decodeGlowupNode,
    registerGlowupStreamingPolicy,
    type GlowupNode,
} from "../../../src/tools/protocol/contract.ts";
import type { ThirdPartyToolRenderContext } from "../../../src/tools/types.ts";
import {
    configureRenderDiagnostics,
    diagnosticCodeHash,
} from "../../../src/diagnostics/render-events.ts";
import type { DebugLogFields } from "../../../src/diagnostics/logger.ts";
import {
    disposeSyntaxHighlighting,
    initializeSyntaxHighlighting,
    settleSyntaxHighlights,
} from "../../../src/rendering/syntax/highlighter.ts";

const theme = { fg: (_token: string, value: string) => value, bold: (value: string) => value };
const context: ThirdPartyToolRenderContext = {
    toolCallId: "same-call",
    args: {},
    argsComplete: true,
    executionStarted: true,
    isPartial: true,
    isError: false,
    expanded: true,
    showImages: false,
};
afterEach(() => {
    selectGlowupPresentation("compact");
});

describe("tool generated-content contract", () => {
    it.each([
        ["agent_browser", { script: "const LEGACY_PENDING =" }],
        ["mcp__chrome-devtools__evaluate_script", { function: "() => { const LEGACY_PENDING =" }],
    ] as const)("routes existing %s code previews through the same gate", (toolName, args) => {
        const inputs: Array<{ complete: boolean; source: string }> = [];
        const renderer = createThirdPartyToolRenderer(toolName, {
            streamCode: (input) => {
                inputs.push(input);
                return "CODE_GATE";
            },
        });
        const rendered = renderer
            .renderCall(args, theme, { ...context, argsComplete: false })
            .render(80)
            .join("\n");
        expect(rendered).toContain("CODE_GATE");
        expect(rendered).not.toContain("LEGACY_PENDING");
        expect(inputs).toHaveLength(1);
        expect(inputs[0]?.complete).toBe(false);
    });

    it.each(["compact", "outline"])(
        "gates %s partial results independently from completed arguments and call streams",
        (presentation) => {
            selectGlowupPresentation(presentation);
            const inputs: Array<{ key: string; complete: boolean }> = [];
            const renderer = createProtocolRenderer(
                {
                    version: 3,
                    parseArgs: (value) => value,
                    parseResult: (value) => value,
                    renderCall: () => code("CALL", { syntax: { language: "javascript" } }),
                    renderResult: () =>
                        code("RESULT unfinished =", { syntax: { language: "javascript" } }),
                },
                createGenericRenderer("test"),
                "static",
                undefined,
                (input) => {
                    inputs.push(input);
                    return input.complete ? input.source : "";
                },
            );
            expect(renderer.renderCall({}, theme, context).render(80).join("\n")).toContain("CALL");
            expect(
                renderer
                    .renderResult({}, { expanded: true, isPartial: true }, theme, context)
                    .render(80)
                    .join("\n"),
            ).not.toContain("unfinished");

            expect(inputs.map((input) => input.complete)).toEqual([true, false]);
            expect(inputs[0]?.key).not.toBe(inputs[1]?.key);
            expect(
                renderer
                    .renderResult({}, { expanded: true, isPartial: false }, theme, context)
                    .render(80)
                    .join("\n"),
            ).toContain("unfinished");

            expect(
                renderer
                    .renderResult({}, { expanded: true, isPartial: true }, theme, {
                        ...context,
                        isError: true,
                    })
                    .render(80)
                    .join("\n"),
            ).toContain("unfinished");
        },
    );

    it.each([compactPresentation, outlinePresentation])(
        "shares generated prose policy but leaves ordinary output immediate",
        (presentation) => {
            const seen: string[] = [];
            const handle = registerGlowupStreamingPolicy({
                present(input) {
                    seen.push(input.key);
                    return input.complete ? input.source : "";
                },
                settled: async () => {},
            });
            try {
                const node = stack([
                    output("stdout unfinished", { syntax: { language: "javascript" } }),
                    output("child unfinished", {
                        streaming: { kind: "markdown", complete: false, key: "child-a" },
                    }),
                    output("explicit raw", {
                        streaming: { kind: "markdown", complete: false, mode: "immediate" },
                    }),
                ]);
                const rendered = presentation
                    .renderNode(node, theme, context, "static")
                    .render(80)
                    .join("\n");
                expect(rendered).toContain("stdout unfinished");
                expect(rendered).toContain("explicit raw");
                expect(rendered).not.toContain("child unfinished");
                expect(seen).toHaveLength(1);
                expect(seen[0]).toContain("child-a");
            } finally {
                handle.dispose();
            }
        },
    );

    it("keeps separate protocol code children current under the same host invalidation", async () => {
        const entries: Array<{ event: string; fields: DebugLogFields }> = [];
        const first = "const alpha = 1;";
        const second = "const beta = 2;";
        const node = stack([
            code(first, { syntax: { language: "javascript" } }),
            code(second, { syntax: { language: "javascript" } }),
        ]);
        try {
            await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
            configureRenderDiagnostics((event, fields) => {
                entries.push({ event, fields: fields() });
            });
            const component = compactPresentation.renderNode(
                node,
                theme,
                { ...context, invalidate: () => {} },
                "static",
            );
            component.render(80);
            await settleSyntaxHighlights();
            const terminals = entries.filter(
                ({ event, fields }) =>
                    event === "syntax_request" &&
                    fields.terminal === true &&
                    (fields.codeHash === diagnosticCodeHash(first) ||
                        fields.codeHash === diagnosticCodeHash(second)),
            );
            expect(terminals.map(({ fields }) => fields.state)).toEqual(["completed", "completed"]);
            expect(new Set(terminals.map(({ fields }) => fields.ownerId)).size).toBe(2);
        } finally {
            configureRenderDiagnostics(undefined);
            await disposeSyntaxHighlighting();
        }
    });

    it("reuses a protocol child's logical owner across A to B to A source changes", async () => {
        const entries: Array<{ event: string; fields: DebugLogFields }> = [];
        const first = "const alpha = 1;";
        const second = "const beta = 2;";
        const invalidate = () => {};
        const render = (
            source: string,
            lastComponent?: Parameters<typeof compactPresentation.renderNode>[2]["lastComponent"],
        ) =>
            compactPresentation.renderNode(
                stack([code(source, { syntax: { language: "javascript" } })]),
                theme,
                { ...context, invalidate, lastComponent },
                "static",
            );
        try {
            await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
            configureRenderDiagnostics((event, fields) => {
                entries.push({ event, fields: fields() });
            });
            const a = render(first);
            a.render(80);
            const b = render(second, a);
            b.render(80);
            const current = render(first, b);
            current.render(80);
            await settleSyntaxHighlights();
            const starts = entries.filter(
                ({ event, fields }) => event === "syntax_request" && fields.state === "requested",
            );
            expect(starts.map(({ fields }) => fields.revision)).toEqual([1, 2, 3]);
            expect(new Set(starts.map(({ fields }) => fields.ownerId)).size).toBe(1);
            expect(
                entries
                    .filter(
                        ({ event, fields }) =>
                            event === "syntax_request" && fields.terminal === true,
                    )
                    .map(({ fields }) => fields.state),
            ).toEqual(["superseded", "superseded", "completed"]);
        } finally {
            configureRenderDiagnostics(undefined);
            await disposeSyntaxHighlighting();
        }
    });

    it.each([false, true])(
        "keeps reused protocol components isolated across tool calls (stack: %s)",
        async (nested) => {
            const entries: Array<{ event: string; fields: DebugLogFields }> = [];
            const source = "const shared = 4;";
            const child = code(source, { syntax: { language: "javascript" } });
            let node: GlowupNode = child;

            if (nested) node = stack([child]);

            const invalidate = () => {};
            try {
                await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
                configureRenderDiagnostics((event, fields) => {
                    entries.push({ event, fields: fields() });
                });
                const first = compactPresentation.renderNode(
                    node,
                    theme,
                    { ...context, toolCallId: "first", invalidate },
                    "static",
                );
                first.render(80);
                const second = compactPresentation.renderNode(
                    node,
                    theme,
                    { ...context, toolCallId: "second", invalidate, lastComponent: first },
                    "static",
                );
                second.render(80);
                await settleSyntaxHighlights();
                const starts = entries.filter(
                    ({ event, fields }) =>
                        event === "syntax_request" &&
                        fields.codeHash === diagnosticCodeHash(source) &&
                        fields.state === "requested",
                );
                expect(starts).toHaveLength(2);
                expect(new Set(starts.map(({ fields }) => fields.ownerId)).size).toBe(2);
            } finally {
                configureRenderDiagnostics(undefined);
                await disposeSyntaxHighlighting();
            }
        },
    );

    it.each([
        [false, false],
        [true, false],
        [false, true],
        [true, true],
    ])(
        "retires replaced code under a protocol call (nested stack: %s, independent: %s)",
        async (nested, independent) => {
            const events: Array<{ event: string; fields: DebugLogFields }> = [];
            let invalidations = 0;

            const state = {};

            const renderer = createProtocolRenderer(
                {
                    version: 3,
                    ...(independent && { independentExpansion: true as const }),
                    parseArgs: (value) => value,
                    renderCall: (value) => {
                        const source = Value.Parse(Type.String(), value);
                        const child = code(source, { syntax: { language: "javascript" } });
                        let body: GlowupNode = child;

                        if (nested) body = stack([child]);

                        return call({ static: "Run" }, { body });
                    },
                },
                createGenericRenderer("test"),
            );
            const invalidate = () => {
                invalidations += 1;
            };
            try {
                await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
                configureRenderDiagnostics((event, fields) => {
                    events.push({ event, fields: fields() });
                });
                const first = renderer.renderCall("const one = 1;", theme, {
                    ...context,
                    state,
                    invalidate,
                });
                first.render(80);
                const second = renderer.renderCall("const two = 2;", theme, {
                    ...context,
                    state,
                    invalidate,
                    lastComponent: first,
                });
                second.render(80);
                const current = renderer.renderCall("const one = 1;", theme, {
                    ...context,
                    state,
                    invalidate,
                    lastComponent: second,
                });
                current.render(80);
                await settleSyntaxHighlights();
                const starts = events.filter(
                    ({ event, fields }) =>
                        event === "syntax_request" && fields.state === "requested",
                );
                expect(starts.map(({ fields }) => fields.revision)).toEqual([1, 2, 3]);
                expect(new Set(starts.map(({ fields }) => fields.ownerId)).size).toBe(1);
                expect(
                    events
                        .filter(
                            ({ event, fields }) =>
                                event === "syntax_request" && fields.terminal === true,
                        )
                        .map(({ fields }) => fields.state),
                ).toEqual(["superseded", "superseded", "completed"]);

                expect(invalidations).toBe(1);
            } finally {
                configureRenderDiagnostics(undefined);
                await disposeSyntaxHighlighting();
            }
        },
    );

    it.each([false, true])(
        "retains call child ownership across width and expansion changes (independent: %s)",
        async (independent) => {
            const events: Array<{ event: string; fields: DebugLogFields }> = [];
            let invalidations = 0;

            const state = {};
            const renderer = createProtocolRenderer(
                {
                    version: 3,
                    ...(independent && { independentExpansion: true as const }),
                    parseArgs: (value) => value,
                    renderCall: () =>
                        call(
                            { static: "Run" },
                            {
                                body: stack([
                                    code("const value = 4;", {
                                        syntax: { language: "javascript" },
                                    }),
                                ]),
                            },
                        ),
                },
                createGenericRenderer("test"),
            );
            const invalidate = () => {
                invalidations += 1;
            };
            try {
                await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
                configureRenderDiagnostics((event, fields) => {
                    events.push({ event, fields: fields() });
                });
                const first = renderer.renderCall({}, theme, {
                    ...context,
                    state,
                    expanded: false,
                    invalidate,
                });
                first.render(80);
                const second = renderer.renderCall({}, theme, {
                    ...context,
                    state,
                    expanded: true,
                    invalidate,
                    lastComponent: first,
                });
                second.render(120);
                const current = renderer.renderCall({}, theme, {
                    ...context,
                    state,
                    expanded: false,
                    invalidate,
                    lastComponent: second,
                });
                current.render(80);
                await settleSyntaxHighlights();
                const starts = events.filter(
                    ({ event, fields }) =>
                        event === "syntax_request" && fields.state === "requested",
                );
                expect(starts).toHaveLength(1);
                expect(invalidations).toBe(1);
            } finally {
                configureRenderDiagnostics(undefined);
                await disposeSyntaxHighlighting();
            }
        },
    );

    it("keeps independent sibling owners inside a protocol call", async () => {
        const events: Array<{ event: string; fields: DebugLogFields }> = [];
        const fixed = "const fixed = 10;";
        const renderer = createProtocolRenderer(
            {
                version: 3,
                parseArgs: (value) => value,
                renderCall: (value) => {
                    const source = Value.Parse(Type.String(), value);

                    return call(
                        { static: "Run" },
                        {
                            body: stack([
                                code(source, { syntax: { language: "javascript" } }),
                                code(fixed, { syntax: { language: "javascript" } }),
                            ]),
                        },
                    );
                },
            },
            createGenericRenderer("test"),
        );
        const invalidate = () => {};
        try {
            await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
            configureRenderDiagnostics((event, fields) => {
                events.push({ event, fields: fields() });
            });
            const first = renderer.renderCall("const first = 1;", theme, {
                ...context,
                invalidate,
            });
            first.render(80);
            const current = renderer.renderCall("const second = 2;", theme, {
                ...context,
                invalidate,
                lastComponent: first,
            });
            current.render(80);
            await settleSyntaxHighlights();
            const starts = events.filter(
                ({ event, fields }) => event === "syntax_request" && fields.state === "requested",
            );
            const fixedStarts = starts.filter(
                ({ fields }) => fields.codeHash === diagnosticCodeHash(fixed),
            );
            const changedStarts = starts.filter(
                ({ fields }) => fields.codeHash !== diagnosticCodeHash(fixed),
            );
            expect(fixedStarts).toHaveLength(1);
            expect(changedStarts.map(({ fields }) => fields.revision)).toEqual([1, 2]);
            expect(changedStarts[0]?.fields.ownerId).toBe(changedStarts[1]?.fields.ownerId);
            expect(fixedStarts[0]?.fields.ownerId).not.toBe(changedStarts[0]?.fields.ownerId);
            const fixedTerminal = events.filter(
                ({ event, fields }) =>
                    event === "syntax_request" &&
                    fields.terminal === true &&
                    fields.codeHash === diagnosticCodeHash(fixed),
            );
            expect(fixedTerminal.map(({ fields }) => fields.state)).toEqual(["completed"]);
        } finally {
            configureRenderDiagnostics(undefined);
            await disposeSyntaxHighlighting();
        }
    });

    it("keeps syntax ownership when a protocol section is expanded by a click", async () => {
        const events: Array<{ event: string; fields: DebugLogFields }> = [];
        const source = Array.from(
            { length: 12 },
            (_, index) => `const value${index} = ${index};`,
        ).join("\n");
        const renderer = createProtocolRenderer(
            {
                version: 3,
                independentExpansion: true,
                parseArgs: (value) => value,
                renderCall: () =>
                    call(
                        { static: "Run" },
                        { body: stack([code(source, { syntax: { language: "javascript" } })]) },
                    ),
            },
            createGenericRenderer("test"),
        );

        const state = {};
        let invalidations = 0;
        const invalidate = () => {
            invalidations += 1;
        };
        try {
            await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
            configureRenderDiagnostics((event, fields) => {
                events.push({ event, fields: fields() });
            });
            const first = renderer.renderCall({}, theme, {
                ...context,
                expanded: false,
                state,
                invalidate,
            });
            first.render(80);
            expect(
                first.handleMouse?.({
                    type: "click",
                    button: "left",
                    x: 0,
                    y: 0,
                    screenX: 0,
                    screenY: 0,
                    width: 80,
                    height: 20,
                    shift: false,
                    alt: false,
                    ctrl: false,
                }),
            ).toMatchObject({ handled: true });
            const expanded = renderer.renderCall({}, theme, {
                ...context,
                expanded: false,
                state,
                invalidate,
                lastComponent: first,
            });
            expect(expanded.render(80).join("\n")).toContain("value11");
            await settleSyntaxHighlights();
            const starts = events.filter(
                ({ event, fields }) => event === "syntax_request" && fields.state === "requested",
            );
            expect(new Set(starts.map(({ fields }) => fields.ownerId)).size).toBe(1);
            expect(invalidations).toBeGreaterThan(0);
        } finally {
            configureRenderDiagnostics(undefined);
            await disposeSyntaxHighlighting();
        }
    });

    it("passes code streaming through public renderer contributions", () => {
        const registration = registerGlowupToolRenderer(
            "streaming-test",
            (name) => name === "contributed",
            {
                version: 3,
                parseArgs: (value) => value,
                renderCall: () => code("unfinished", { syntax: { language: "javascript" } }),
            },
        );
        try {
            const renderer = createThirdPartyToolRenderer("contributed", {
                streamCode: () => "GATED",
            });
            const rendered = renderer.renderCall({}, theme, context).render(80).join("\n");
            expect(rendered).toContain("GATED");
            expect(rendered).not.toContain("unfinished");
        } finally {
            registration.dispose();
        }
    });

    it("decodes detached streaming declarations and rejects invalid policy fields", () => {
        const streaming = {
            kind: "markdown" as const,
            complete: false,
            key: "child",
            mode: "inherit" as const,
        };
        const node = output("source", { streaming });
        const decoded = decodeGlowupNode(node);
        expect(decoded).toEqual(node);
        expect(decoded).not.toBe(node);
        expect(decoded?.kind === "output" && decoded.streaming).not.toBe(streaming);
        expect(decodeGlowupNode({ ...node, streaming: { kind: "terminal" } })).toBeUndefined();
        expect(
            decodeGlowupNode({ ...node, streaming: { ...streaming, complete: "yes" } }),
        ).toBeUndefined();
    });
});
