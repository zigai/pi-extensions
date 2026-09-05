import { describe, expect, it } from "vitest";
import type { GlowupRenderTheme } from "../src/rendering/core.ts";
import { call, text } from "../src/tool-rendering/protocol.ts";
import type { JsonValue } from "../src/json-value.js";
import type {
    ThirdPartyToolRendererPlugin,
    ThirdPartyToolResult,
} from "../src/third-party-tools/renderers.ts";
import {
    configureBuiltInToolRendererPatch,
    configureCompletedLineCache,
    configureThirdPartyToolRendererPatch,
    toolRendererPatchStats,
    type BuiltInToolRenderContext,
} from "../src/patches/tool-execution-patch.ts";

function installBuiltInToolRendererPatch(
    options: Parameters<typeof configureBuiltInToolRendererPatch>[1],
    prototype: Parameters<typeof configureBuiltInToolRendererPatch>[2],
): void {
    configureBuiltInToolRendererPatch(true, options, prototype);
}

function installThirdPartyToolRendererPatch(
    options: Parameters<typeof configureThirdPartyToolRendererPatch>[1],
    prototype: Parameters<typeof configureThirdPartyToolRendererPatch>[2],
): void {
    configureThirdPartyToolRendererPatch(true, options, prototype);
}

const plainTheme: GlowupRenderTheme = {
    fg(_token: string, text: string): string {
        return text;
    },
    bg(_token: string, text: string): string {
        return text;
    },
    bold(text: string): string {
        return text;
    },
};

type FakeComponent = {
    render(width: number): string[];
    invalidate(): void;
};

type FakeCallRenderer = (
    args: BuiltInToolRenderContext["args"],
    theme: GlowupRenderTheme,
    context: FakeRenderContext,
) => FakeComponent;
type FakeResultRenderer = (
    result: ThirdPartyToolResult,
    options: { readonly expanded: boolean; readonly isPartial: boolean },
    theme: GlowupRenderTheme,
    context: FakeRenderContext,
) => FakeComponent;

type FakeRenderContext = Omit<
    BuiltInToolRenderContext,
    "cwd" | "state" | "invalidate" | "lastComponent"
> &
    Partial<Pick<BuiltInToolRenderContext, "cwd" | "state" | "invalidate" | "lastComponent">>;

type FakeToolExecutionInstance = {
    readonly toolName: string;
    readonly builtInToolDefinition?: unknown;
    readonly toolDefinition?: unknown;
    readonly executionStarted?: boolean;
    readonly result?: unknown;
};

type FakeToolExecutionComponent = {
    readonly toolName?: string;
    readonly toolDefinition?: unknown;
    readonly builtInToolDefinition?: unknown;
};

type FakeToolExecutionPrototype = {
    getCallRenderer(this: FakeToolExecutionComponent): FakeCallRenderer | undefined;
    getResultRenderer(this: FakeToolExecutionComponent): FakeResultRenderer | undefined;
    getRenderShell(this: FakeToolExecutionComponent): "default" | "self";
    hasRendererDefinition(this: FakeToolExecutionComponent): boolean;
};

function noop(): void {}

const renderContext: FakeRenderContext = {
    args: {},
    toolCallId: "call-1",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
};

function createPrototype(): FakeToolExecutionPrototype {
    const existingComponent = (): FakeComponent => ({
        render(): string[] {
            return ["existing renderer"];
        },
        invalidate(): void {},
    });
    const existingCallRenderer: FakeCallRenderer = () => existingComponent();
    const existingResultRenderer: FakeResultRenderer = () => existingComponent();

    return {
        getCallRenderer(): FakeCallRenderer | undefined {
            return existingCallRenderer;
        },
        getResultRenderer(): FakeResultRenderer | undefined {
            return existingResultRenderer;
        },
        getRenderShell(): "default" | "self" {
            return "default";
        },
        hasRendererDefinition(): boolean {
            return false;
        },
    };
}

describe("tool execution patches", () => {
    it.each([
        { name: "JSON arguments", args: { query: "select 1" }, expected: { query: "select 1" } },
        { name: "non-JSON arguments", args: { query: () => "select 1" }, expected: undefined },
        {
            name: "unreadable arguments",
            args: {
                get query(): string {
                    throw new Error("unreadable host property");
                },
            },
            expected: undefined,
        },
    ])("decodes $name before third-party dispatch", ({ args, expected }) => {
        const prototype = createPrototype();
        const received: Array<JsonValue | undefined> = [];
        installThirdPartyToolRendererPatch(
            {
                renderers: [
                    {
                        name: "boundary-test",
                        matches: (name) => name === "boundary_test",
                        createRenderer: () => ({
                            renderCall(value, _theme, context) {
                                received.push(value, context.args);
                                return { render: () => ["rendered"], invalidate: noop };
                            },
                            renderResult: () => ({ render: () => [], invalidate: noop }),
                        }),
                    },
                ],
            },
            prototype,
        );
        const instance: FakeToolExecutionInstance = {
            toolName: "boundary_test",
            toolDefinition: {},
        };
        const renderer = prototype.getCallRenderer.call(instance);
        expect(renderer?.(args, plainTheme, { ...renderContext, args }).render(80)).toEqual([
            "rendered",
        ]);
        expect(received).toEqual([expected, expected]);
    });

    it("renders built-in names with Pi's resolved tool definition and no legacy field", () => {
        const prototype = createPrototype();
        installBuiltInToolRendererPatch(
            {
                renderCall: (toolName) => ({
                    render: () => [`called ${toolName}`],
                    invalidate: noop,
                }),
                renderResult: (toolName) => ({
                    render: () => [`result ${toolName}`],
                    invalidate: noop,
                }),
            },
            prototype,
        );

        const readInstance: FakeToolExecutionInstance = {
            toolName: "read",
            toolDefinition: {},
        };
        const customInstance: FakeToolExecutionInstance = {
            toolName: "custom_tool",
            toolDefinition: {},
        };

        expect(prototype.getRenderShell.call(readInstance)).toBe("self");
        expect(prototype.hasRendererDefinition.call(readInstance)).toBe(true);
        expect(
            prototype.getCallRenderer
                .call(readInstance)?.({}, plainTheme, renderContext)
                .render(80),
        ).toEqual(["called read"]);
        expect(
            prototype.getResultRenderer
                .call(readInstance)?.(
                    { content: [] },
                    { expanded: false, isPartial: false },
                    plainTheme,
                    renderContext,
                )
                .render(80),
        ).toEqual(["result read"]);
        expect(prototype.getRenderShell.call(customInstance)).toBe("default");
    });

    it("passes persisted results to restored built-in call renderers", () => {
        const prototype = createPrototype();
        let receivedResult: ThirdPartyToolResult | undefined;
        let receivedArgsComplete: boolean | undefined;
        installBuiltInToolRendererPatch(
            {
                renderCall: (_toolName, _args, _theme, context) => {
                    receivedResult = context.result;
                    receivedArgsComplete = context.argsComplete;
                    return { render: () => ["restored"], invalidate: noop };
                },
                renderResult: () => undefined,
            },
            prototype,
        );
        const instance: FakeToolExecutionInstance = {
            toolName: "write",
            builtInToolDefinition: {},
            result: { content: [], details: { diff: "+1 restored" } },
        };

        prototype.getCallRenderer
            .call(instance)?.({}, plainTheme, {
                ...renderContext,
                argsComplete: false,
                executionStarted: false,
            })
            .render(80);

        expect(receivedResult).toEqual({ content: [], details: { diff: "+1 restored" } });
        expect(receivedArgsComplete).toBe(true);
    });

    it("does not inject results into actively executed built-in call renderers", () => {
        const prototype = createPrototype();
        let receivedResult: ThirdPartyToolResult | undefined;
        installBuiltInToolRendererPatch(
            {
                renderCall: (_toolName, _args, _theme, context) => {
                    receivedResult = context.result;
                    return { render: () => ["live"], invalidate: noop };
                },
                renderResult: () => undefined,
            },
            prototype,
        );
        const instance: FakeToolExecutionInstance = {
            toolName: "write",
            builtInToolDefinition: {},
            executionStarted: true,
            result: { content: [], details: { diff: "+1 live" } },
        };

        prototype.getCallRenderer.call(instance)?.({}, plainTheme, renderContext).render(80);

        expect(receivedResult).toBeUndefined();
    });

    it("renders compatibility tool names through canonical built-in renderers", () => {
        const prototype = createPrototype();
        installBuiltInToolRendererPatch(
            {
                renderCall: (toolName) => ({
                    render: () => [`called ${toolName}`],
                    invalidate: noop,
                }),
                renderResult: (toolName) => ({
                    render: () => [`result ${toolName}`],
                    invalidate: noop,
                }),
            },
            prototype,
        );

        const lsInstance: FakeToolExecutionInstance = {
            toolName: "LS",
            toolDefinition: {},
        };
        const deleteInstance: FakeToolExecutionInstance = {
            toolName: "Delete",
            toolDefinition: {},
        };

        expect(prototype.getRenderShell.call(lsInstance)).toBe("self");
        expect(prototype.hasRendererDefinition.call(lsInstance)).toBe(true);
        expect(
            prototype.getCallRenderer.call(lsInstance)?.({}, plainTheme, renderContext).render(80),
        ).toEqual(["called ls"]);
        expect(
            prototype.getResultRenderer
                .call(lsInstance)?.(
                    { content: [] },
                    { expanded: false, isPartial: false },
                    plainTheme,
                    renderContext,
                )
                .render(80),
        ).toEqual(["result ls"]);
        expect(
            prototype.getCallRenderer
                .call(deleteInstance)?.({}, plainTheme, renderContext)
                .render(80),
        ).toEqual(["called delete"]);
    });

    it("restores built-in tool renderers when disabled", () => {
        const prototype = createPrototype();
        const originalDescriptors = Object.getOwnPropertyDescriptors(prototype);
        const readInstance: FakeToolExecutionInstance = {
            toolName: "read",
            builtInToolDefinition: {},
        };

        configureBuiltInToolRendererPatch(
            true,
            {
                renderCall: (toolName) => ({
                    render: () => [`called ${toolName}`],
                    invalidate: noop,
                }),
                renderResult: (toolName) => ({
                    render: () => [`result ${toolName}`],
                    invalidate: noop,
                }),
            },
            prototype,
        );
        expect(prototype.getRenderShell.call(readInstance)).toBe("self");

        configureBuiltInToolRendererPatch(false, undefined, prototype);

        expect(Object.getOwnPropertyDescriptors(prototype)).toMatchObject(originalDescriptors);
        expect(prototype.getRenderShell.call(readInstance)).toBe("default");
    });

    it("leaves built-in tools on their original render path", () => {
        const prototype = createPrototype();
        installThirdPartyToolRendererPatch(undefined, prototype);

        const instance: FakeToolExecutionInstance = {
            toolName: "read",
            builtInToolDefinition: {},
            toolDefinition: {},
        };

        expect(prototype.getRenderShell.call(instance)).toBe("default");
        expect(prototype.hasRendererDefinition.call(instance)).toBe(false);
        expect(
            prototype.getCallRenderer.call(instance)?.({}, plainTheme, renderContext).render(80),
        ).toEqual(["existing renderer"]);
    });

    it("auto-converts unknown third-party tools to self-shell Glowup rendering", () => {
        const prototype = createPrototype();
        installThirdPartyToolRendererPatch(undefined, prototype);

        const instance: FakeToolExecutionInstance = {
            toolName: "custom_tool",
            toolDefinition: {},
        };

        expect(prototype.getRenderShell.call(instance)).toBe("self");
        expect(prototype.hasRendererDefinition.call(instance)).toBe(true);

        const renderer = prototype.getCallRenderer.call(instance);
        expect(renderer?.({ value: 1 }, plainTheme, renderContext).render(80).join("\n")).toContain(
            "• custom_tool",
        );
    });

    it("passes lifecycle label mode through the third-party renderer patch", () => {
        const prototype = createPrototype();
        installThirdPartyToolRendererPatch({ labelMode: "lifecycle" }, prototype);
        const instance: FakeToolExecutionInstance = {
            toolName: "custom_tool",
            toolDefinition: {},
        };

        const active = prototype.getCallRenderer
            .call(instance)?.({}, plainTheme, {
                ...renderContext,
                executionStarted: false,
                argsComplete: false,
                isPartial: true,
            })
            .render(80)
            .join("\n");
        const completed = prototype.getCallRenderer
            .call(instance)?.({}, plainTheme, renderContext)
            .render(80)
            .join("\n");

        expect(active).toBe("");
        expect(completed).toContain("Called custom_tool");
    });

    it("preserves native third-party renderers unless they opt in", () => {
        const prototype = createPrototype();
        prototype.hasRendererDefinition = function hasNativeRendererDefinition(): boolean {
            return true;
        };
        installThirdPartyToolRendererPatch(undefined, prototype);

        const instance: FakeToolExecutionInstance = {
            toolName: "custom_tool",
            toolDefinition: { renderCall: () => ({ render: () => [], invalidate: noop }) },
        };

        expect(prototype.getRenderShell.call(instance)).toBe("default");
        expect(prototype.hasRendererDefinition.call(instance)).toBe(true);
        expect(
            prototype.getCallRenderer.call(instance)?.({}, plainTheme, renderContext).render(80),
        ).toEqual(["existing renderer"]);
    });

    it("parses complete structured arguments for restored third-party calls", () => {
        const prototype = createPrototype();
        installThirdPartyToolRendererPatch({ labelMode: "lifecycle" }, prototype);
        const instance: FakeToolExecutionInstance = {
            toolName: "ask_user_question",
            toolDefinition: {},
            result: {
                content: [
                    {
                        type: "text",
                        text: 'User has answered your questions: "Which candidates?"="Stable only".',
                    },
                ],
            },
        };

        const rendered = prototype.getCallRenderer
            .call(instance)?.(
                {
                    questions: [
                        {
                            header: "Candidates",
                            question: "Which candidates?",
                            options: [
                                {
                                    label: "Stable only",
                                    description: "Use stable candidates.",
                                },
                            ],
                        },
                    ],
                },
                plainTheme,
                {
                    ...renderContext,
                    argsComplete: false,
                    executionStarted: false,
                    isPartial: false,
                },
            )
            .render(120)
            .join("\n");

        expect(rendered).toContain("Asked User");
        expect(rendered).toContain("Candidates");
        expect(rendered).toContain("Which candidates?");
        expect(rendered).toContain("Choose one:");
        expect(rendered).toContain("Stable only");
        expect(rendered).not.toContain("questions: 1 item");
    });

    it("uses passive Glowup adapters over native third-party renderers", () => {
        const prototype = createPrototype();
        prototype.hasRendererDefinition = function hasNativeRendererDefinition(): boolean {
            return true;
        };
        installThirdPartyToolRendererPatch(undefined, prototype);

        const instance: FakeToolExecutionInstance = {
            toolName: "db_query",
            toolDefinition: {
                renderCall: () => ({ render: () => [], invalidate: noop }),
                glowupRendering: {
                    version: 3,
                    parseArgs(value: JsonValue) {
                        return value;
                    },
                    renderCall: () => call({ static: "DB Query" }, { body: text("select 1") }),
                },
            },
        };

        expect(prototype.getRenderShell.call(instance)).toBe("self");
        expect(prototype.hasRendererDefinition.call(instance)).toBe(true);
        expect(
            prototype.getCallRenderer
                .call(instance)?.({}, plainTheme, renderContext)
                .render(80)
                .join("\n"),
        ).toContain("DB Query select 1");
    });

    it("rebuilds cached renderers when a tool definition is replaced", () => {
        const prototype = createPrototype();
        installThirdPartyToolRendererPatch(undefined, prototype);
        const makeInstance = (label: string): FakeToolExecutionInstance => ({
            toolName: "dynamic_tool",
            toolDefinition: {
                glowupRendering: {
                    version: 3,
                    parseArgs(value: JsonValue) {
                        return value;
                    },
                    renderCall: () => call({ static: label }),
                },
            },
        });

        const first = prototype.getCallRenderer
            .call(makeInstance("First Definition"))?.({}, plainTheme, renderContext)
            .render(80)
            .join("\n");
        const second = prototype.getCallRenderer
            .call(makeInstance("Replacement Definition"))?.({}, plainTheme, renderContext)
            .render(80)
            .join("\n");

        expect(first).toContain("First Definition");
        expect(second).toContain("Replacement Definition");
        expect(second).not.toContain("First Definition");
    });

    it("leaves third-party tools on their original render path when disabled", () => {
        const prototype = createPrototype();
        installThirdPartyToolRendererPatch({ enabled: false }, prototype);

        const instance: FakeToolExecutionInstance = {
            toolName: "custom_tool",
            toolDefinition: {},
        };

        expect(prototype.getRenderShell.call(instance)).toBe("default");
        expect(prototype.hasRendererDefinition.call(instance)).toBe(false);
        expect(
            prototype.getCallRenderer.call(instance)?.({}, plainTheme, renderContext).render(80),
        ).toEqual(["existing renderer"]);
    });

    it("restores third-party renderers when disabled", () => {
        const prototype = createPrototype();
        const originalDescriptors = Object.getOwnPropertyDescriptors(prototype);
        const instance: FakeToolExecutionInstance = {
            toolName: "custom_tool",
            toolDefinition: {},
        };

        configureThirdPartyToolRendererPatch(true, undefined, prototype);
        expect(prototype.getRenderShell.call(instance)).toBe("self");

        configureThirdPartyToolRendererPatch(false, undefined, prototype);

        expect(Object.getOwnPropertyDescriptors(prototype)).toMatchObject(originalDescriptors);
        expect(prototype.getRenderShell.call(instance)).toBe("default");
    });

    it("disables third-party behavior without clobbering later wrappers", () => {
        const prototype = createPrototype();
        const instance: FakeToolExecutionInstance = {
            toolName: "custom_tool",
            toolDefinition: {},
        };

        configureThirdPartyToolRendererPatch(true, undefined, prototype);
        const patchedPrototype: FakeToolExecutionPrototype = Object.create(prototype);
        const patchedRendererDescriptor = Object.getOwnPropertyDescriptor(
            prototype,
            "getCallRenderer",
        );
        if (patchedRendererDescriptor === undefined) {
            throw new Error("expected Glowup call renderer wrapper");
        }
        Object.defineProperty(patchedPrototype, "getCallRenderer", patchedRendererDescriptor);
        prototype.getCallRenderer = function getLaterCallRenderer(
            this: FakeToolExecutionComponent,
        ) {
            return patchedPrototype.getCallRenderer.call(this);
        };
        const laterRendererDescriptor = Object.getOwnPropertyDescriptor(
            prototype,
            "getCallRenderer",
        );

        configureThirdPartyToolRendererPatch(false, undefined, prototype);

        expect(Object.getOwnPropertyDescriptor(prototype, "getCallRenderer")).toEqual(
            laterRendererDescriptor,
        );
        expect(
            prototype.getCallRenderer.call(instance)?.({}, plainTheme, renderContext).render(80),
        ).toEqual(["existing renderer"]);
    });

    it("preserves opted-out third-party tools", () => {
        const prototype = createPrototype();
        installThirdPartyToolRendererPatch({ preserveTools: ["rich_tool"] }, prototype);

        const instance: FakeToolExecutionInstance = {
            toolName: "rich_tool",
            toolDefinition: {},
        };

        expect(prototype.getRenderShell.call(instance)).toBe("default");
        expect(prototype.hasRendererDefinition.call(instance)).toBe(false);
        expect(
            prototype.getCallRenderer.call(instance)?.({}, plainTheme, renderContext).render(80),
        ).toEqual(["existing renderer"]);
    });

    it("reuses generated third-party renderers between render passes", () => {
        let createdRenderers = 0;
        const prototype = createPrototype();
        const plugin: ThirdPartyToolRendererPlugin = {
            name: "recording-plugin",
            matches: (toolName) => toolName === "recorded_tool",
            createRenderer: (toolName) => {
                createdRenderers += 1;
                return {
                    renderCall: () => ({
                        render: () => [`called ${toolName}`],
                        invalidate: noop,
                    }),
                    renderResult: () => ({
                        render: () => [`result ${toolName}`],
                        invalidate: noop,
                    }),
                };
            },
        };
        installThirdPartyToolRendererPatch({ renderers: [plugin] }, prototype);

        const instance: FakeToolExecutionInstance = {
            toolName: "recorded_tool",
            toolDefinition: {},
        };

        expect(
            prototype.getCallRenderer.call(instance)?.({}, plainTheme, renderContext).render(80),
        ).toEqual(["called recorded_tool"]);
        expect(
            prototype.getResultRenderer
                .call(instance)?.(
                    { content: [] },
                    { expanded: false, isPartial: false },
                    plainTheme,
                    renderContext,
                )
                .render(80),
        ).toEqual(["result recorded_tool"]);
        expect(
            prototype.getCallRenderer.call(instance)?.({}, plainTheme, renderContext).render(80),
        ).toEqual(["called recorded_tool"]);
        expect(createdRenderers).toBe(1);
    });

    it("is idempotent for a patched prototype", () => {
        const prototype = createPrototype();

        installThirdPartyToolRendererPatch(undefined, prototype);
        const patchedGetCallRendererDescriptor = Object.getOwnPropertyDescriptor(
            prototype,
            "getCallRenderer",
        );
        installThirdPartyToolRendererPatch(undefined, prototype);

        expect(Object.getOwnPropertyDescriptor(prototype, "getCallRenderer")).toEqual(
            patchedGetCallRendererDescriptor,
        );
    });

    it("refreshes preserve-tool options on repeat installs without stacking wrappers", () => {
        const prototype = createPrototype();
        const instance: FakeToolExecutionInstance = {
            toolName: "custom_tool",
            toolDefinition: {},
        };

        installThirdPartyToolRendererPatch(undefined, prototype);
        const patchedGetCallRendererDescriptor = Object.getOwnPropertyDescriptor(
            prototype,
            "getCallRenderer",
        );
        expect(prototype.getRenderShell.call(instance)).toBe("self");

        installThirdPartyToolRendererPatch({ preserveTools: ["custom_tool"] }, prototype);

        expect(Object.getOwnPropertyDescriptor(prototype, "getCallRenderer")).toEqual(
            patchedGetCallRendererDescriptor,
        );
        expect(prototype.getRenderShell.call(instance)).toBe("default");
        expect(prototype.hasRendererDefinition.call(instance)).toBe(false);
        expect(
            prototype.getCallRenderer.call(instance)?.({}, plainTheme, renderContext).render(80),
        ).toEqual(["existing renderer"]);
    });

    it("bounds generated renderers by least-recent insertion", () => {
        const prototype = createPrototype();
        let createdRenderers = 0;
        const plugin: ThirdPartyToolRendererPlugin = {
            name: "counting-plugin",
            matches: () => true,
            createRenderer: (toolName) => {
                createdRenderers += 1;
                return {
                    renderCall: () => ({
                        render: () => [`called ${toolName}`],
                        invalidate: noop,
                    }),
                    renderResult: () => ({
                        render: () => [`result ${toolName}`],
                        invalidate: noop,
                    }),
                };
            },
        };
        installThirdPartyToolRendererPatch({ renderers: [plugin] }, prototype);

        for (let index = 0; index < 101; index += 1) {
            prototype.getCallRenderer.call({
                toolName: `tool_${index}`,
                toolDefinition: {},
            })?.({}, plainTheme, renderContext);
        }
        prototype.getCallRenderer.call({ toolName: "tool_0", toolDefinition: {} })?.(
            {},
            plainTheme,
            renderContext,
        );

        expect(createdRenderers).toBe(102);
    });

    it("clears generated renderer cache when renderer plugins change", () => {
        const prototype = createPrototype();
        const instance: FakeToolExecutionInstance = {
            toolName: "recorded_tool",
            toolDefinition: {},
        };
        const firstPlugin: ThirdPartyToolRendererPlugin = {
            name: "first-plugin",
            matches: (toolName) => toolName === "recorded_tool",
            createRenderer: () => ({
                renderCall: () => ({
                    render: () => ["first renderer"],
                    invalidate: noop,
                }),
                renderResult: () => ({
                    render: () => ["first result"],
                    invalidate: noop,
                }),
            }),
        };
        const secondPlugin: ThirdPartyToolRendererPlugin = {
            name: "second-plugin",
            matches: (toolName) => toolName === "recorded_tool",
            createRenderer: () => ({
                renderCall: () => ({
                    render: () => ["second renderer"],
                    invalidate: noop,
                }),
                renderResult: () => ({
                    render: () => ["second result"],
                    invalidate: noop,
                }),
            }),
        };

        installThirdPartyToolRendererPatch({ renderers: [firstPlugin] }, prototype);
        expect(
            prototype.getCallRenderer.call(instance)?.({}, plainTheme, renderContext).render(80),
        ).toEqual(["first renderer"]);

        installThirdPartyToolRendererPatch({ renderers: [secondPlugin] }, prototype);

        expect(
            prototype.getCallRenderer.call(instance)?.({}, plainTheme, renderContext).render(80),
        ).toEqual(["second renderer"]);
    });

    it("reuses completed built-in components across transcript repaints", () => {
        const prototype = createPrototype();
        let callRenders = 0;
        let resultRenders = 0;
        let callLineRenders = 0;
        let resultLineRenders = 0;
        installBuiltInToolRendererPatch(
            {
                renderCall: () => {
                    callRenders += 1;
                    return {
                        render: (width) => {
                            callLineRenders += 1;
                            return [`call:${width}`];
                        },
                        invalidate: noop,
                    };
                },
                renderResult: () => {
                    resultRenders += 1;
                    return {
                        render: (width) => {
                            resultLineRenders += 1;
                            return [`result:${width}`];
                        },
                        invalidate: noop,
                    };
                },
            },
            prototype,
        );
        const instance: FakeToolExecutionInstance = {
            toolName: "read",
            builtInToolDefinition: {},
        };
        const args = { path: "large.ts" };
        const result = { content: [{ type: "text", text: "large output" }] };
        const context = {
            ...renderContext,
            cwd: "/workspace",
            invalidate: noop,
            lastComponent: undefined,
            state: {},
        };

        const firstCall = prototype.getCallRenderer.call(instance)?.(args, plainTheme, context);
        const firstResult = prototype.getResultRenderer.call(instance)?.(
            result,
            { expanded: false, isPartial: false },
            plainTheme,
            context,
        );
        if (firstCall === undefined || firstResult === undefined) {
            throw new Error("expected completed renderers");
        }
        expect(firstCall.render(80)).toEqual(["call:80"]);
        expect(firstResult.render(80)).toEqual(["result:80"]);
        firstCall.invalidate();
        firstResult.invalidate();
        const outerCallComponent = { render: () => firstCall.render(80), invalidate: noop };
        const outerResultComponent = { render: () => firstResult.render(80), invalidate: noop };

        const repeatedCall = prototype.getCallRenderer.call(instance)?.(args, plainTheme, {
            ...context,
            lastComponent: outerCallComponent,
        });
        const repeatedResult = prototype.getResultRenderer.call(instance)?.(
            result,
            { expanded: false, isPartial: false },
            plainTheme,
            { ...context, lastComponent: outerResultComponent },
        );

        expect(repeatedCall).toBe(firstCall);
        expect(repeatedResult).toBe(firstResult);
        expect(repeatedCall?.render(80)).toEqual(["call:80"]);
        expect(repeatedCall?.render(40)).toEqual(["call:40"]);
        expect(repeatedResult?.render(80)).toEqual(["result:80"]);
        expect(repeatedResult?.render(40)).toEqual(["result:40"]);
        expect(callRenders).toBe(1);
        expect(resultRenders).toBe(1);
        expect(callLineRenders).toBe(2);
        expect(resultLineRenders).toBe(2);
    });

    it("evicts completed components for semantic changes and renderer invalidation", () => {
        const prototype = createPrototype();
        let callRenders = 0;
        let repaintRequests = 0;
        let invalidateRenderedCall = noop;
        installBuiltInToolRendererPatch(
            {
                renderCall: (_toolName, _args, _theme, context) => {
                    callRenders += 1;
                    invalidateRenderedCall = context.invalidate;
                    return {
                        render: () => [`call:${context.expanded ? "expanded" : "collapsed"}`],
                        invalidate: noop,
                    };
                },
                renderResult: () => undefined,
            },
            prototype,
        );
        const instance: FakeToolExecutionInstance = {
            toolName: "bash",
            builtInToolDefinition: {},
        };
        const args = { command: "printf output" };
        const context = {
            ...renderContext,
            cwd: "/workspace",
            invalidate: () => {
                repaintRequests += 1;
            },
            lastComponent: undefined,
            state: {},
        };
        const first = prototype.getCallRenderer.call(instance)?.(args, plainTheme, context);
        if (first === undefined) throw new Error("expected completed call renderer");

        const expanded = prototype.getCallRenderer.call(instance)?.(args, plainTheme, {
            ...context,
            expanded: true,
            lastComponent: first,
        });
        expect(expanded?.render(80)).toEqual(["call:expanded"]);
        expect(callRenders).toBe(2);

        invalidateRenderedCall();
        const afterInvalidation = prototype.getCallRenderer.call(instance)?.(args, plainTheme, {
            ...context,
            expanded: true,
            lastComponent: expanded,
        });
        expect(afterInvalidation).not.toBe(expanded);
        expect(callRenders).toBe(3);
        expect(repaintRequests).toBe(1);

        const alternateTheme: GlowupRenderTheme = {
            fg(token, text) {
                return `[${token}]${text}`;
            },
            bg(token, text) {
                return `[${token}]${text}`;
            },
            bold(text) {
                return `**${text}**`;
            },
        };
        const afterThemeChange = prototype.getCallRenderer.call(instance)?.(args, alternateTheme, {
            ...context,
            expanded: true,
            lastComponent: afterInvalidation,
        });
        expect(afterThemeChange).not.toBe(afterInvalidation);
        expect(callRenders).toBe(4);
    });

    it("does not cache streaming rows", () => {
        const prototype = createPrototype();
        let callRenders = 0;
        installBuiltInToolRendererPatch(
            {
                renderCall: () => {
                    callRenders += 1;
                    return { render: () => ["streaming"], invalidate: noop };
                },
                renderResult: () => undefined,
            },
            prototype,
        );
        const instance: FakeToolExecutionInstance = {
            toolName: "write",
            builtInToolDefinition: {},
        };
        const context = {
            ...renderContext,
            argsComplete: false,
            isPartial: true,
            cwd: "/workspace",
            invalidate: noop,
            lastComponent: undefined,
            state: {},
        };
        const first = prototype.getCallRenderer.call(instance)?.({}, plainTheme, context);
        prototype.getCallRenderer.call(instance)?.({}, plainTheme, {
            ...context,
            lastComponent: first,
        });

        expect(callRenders).toBe(2);
    });

    it("reuses completed third-party components without freezing width", () => {
        const prototype = createPrototype();
        let callRenders = 0;
        const plugin: ThirdPartyToolRendererPlugin = {
            name: "completed-row-plugin",
            matches: (toolName) => toolName === "completed_tool",
            createRenderer: () => ({
                renderCall: () => {
                    callRenders += 1;
                    return {
                        render: (width) => [`completed:${width}`],
                        invalidate: noop,
                    };
                },
                renderResult: () => ({ render: () => [], invalidate: noop }),
            }),
        };
        installThirdPartyToolRendererPatch({ renderers: [plugin] }, prototype);
        const instance: FakeToolExecutionInstance = {
            toolName: "completed_tool",
            toolDefinition: {},
        };
        const context = {
            ...renderContext,
            cwd: "/workspace",
            invalidate: noop,
            lastComponent: undefined,
            state: {},
        };
        const args = {};
        const first = prototype.getCallRenderer.call(instance)?.(args, plainTheme, context);
        const repeated = prototype.getCallRenderer.call(instance)?.(args, plainTheme, {
            ...context,
            lastComponent: first,
        });

        expect(repeated).toBe(first);
        expect(repeated?.render(120)).toEqual(["completed:120"]);
        expect(repeated?.render(45)).toEqual(["completed:45"]);
        expect(callRenders).toBe(1);
    });

    it("bounds completed rendered lines with least-recently-used eviction", () => {
        const prototype = createPrototype();
        configureCompletedLineCache({ maxBytes: 8 * 1024 * 1024, maxEntries: 10 });
        const lineRenderCounts: number[] = [];
        let rendererIndex = 0;
        const options = {
            renderCall: () => {
                const index = rendererIndex;
                rendererIndex += 1;
                lineRenderCounts[index] = 0;
                return {
                    render: () => {
                        lineRenderCounts[index] = (lineRenderCounts[index] ?? 0) + 1;
                        return [`${index}:${"x".repeat(2 * 1024 * 1024)}`];
                    },
                    invalidate: noop,
                };
            },
            renderResult: () => undefined,
        } satisfies Parameters<typeof configureBuiltInToolRendererPatch>[1];
        installBuiltInToolRendererPatch(options, prototype);
        installBuiltInToolRendererPatch(options, prototype);
        const before = toolRendererPatchStats(prototype);
        expect(before.completedLineCacheBytes).toBe(0);
        expect(before.completedLineCacheLimitBytes).toBe(8 * 1024 * 1024);
        expect(before.completedLineCacheLimitEntries).toBe(10);

        const components: FakeComponent[] = [];
        for (let index = 0; index < 6; index += 1) {
            const instance: FakeToolExecutionInstance = {
                toolName: "read",
                builtInToolDefinition: {},
            };
            const component = prototype.getCallRenderer.call(instance)?.(
                { path: `large-${index}.txt` },
                plainTheme,
                {
                    ...renderContext,
                    cwd: "/workspace",
                    invalidate: noop,
                    lastComponent: undefined,
                },
            );
            if (component === undefined) throw new Error("expected completed renderer");
            components.push(component);
            component.render(80);
        }

        const filled = toolRendererPatchStats(prototype);
        expect(filled.completedLineCacheBytes).toBeLessThanOrEqual(
            filled.completedLineCacheLimitBytes,
        );
        expect(filled.completedLineCacheEntries).toBeLessThan(components.length);
        expect(filled.completedLineCacheEntries).toBeLessThanOrEqual(
            filled.completedLineCacheLimitEntries,
        );
        expect(filled.completedLineCacheEvictions).toBeGreaterThan(
            before.completedLineCacheEvictions,
        );

        components[0]?.render(80);
        expect(lineRenderCounts[0]).toBe(2);
        const afterReuse = toolRendererPatchStats(prototype);
        expect(afterReuse.completedLineCacheBytes).toBeLessThanOrEqual(
            afterReuse.completedLineCacheLimitBytes,
        );

        configureCompletedLineCache({ maxBytes: 4 * 1024 * 1024, maxEntries: 2 });
        const reconfigured = toolRendererPatchStats(prototype);
        expect(reconfigured.completedLineCacheBytes).toBe(0);
        expect(reconfigured.completedLineCacheLimitBytes).toBe(4 * 1024 * 1024);
        expect(reconfigured.completedLineCacheLimitEntries).toBe(2);
        components.at(-1)?.render(80);
        const afterReconfiguration = toolRendererPatchStats(prototype);
        expect(afterReconfiguration.completedLineCacheBytes).toBeLessThanOrEqual(
            afterReconfiguration.completedLineCacheLimitBytes,
        );
        expect(afterReconfiguration.completedLineCacheEntries).toBeLessThanOrEqual(2);

        configureBuiltInToolRendererPatch(false, undefined, prototype);
        expect(toolRendererPatchStats(prototype).completedLineCacheBytes).toBe(0);
        configureCompletedLineCache({ maxBytes: 64 * 1024 * 1024, maxEntries: 10_000 });
    });
});
