import { describe, expect, it } from "vitest";
import type { GlowupRenderTheme } from "../src/rendering/core.ts";
import { call, text } from "../src/tool-rendering/protocol.ts";
import type {
    ThirdPartyToolRenderer,
    ThirdPartyToolRendererPlugin,
} from "../src/third-party-tools/renderers.ts";
import {
    configureBuiltInToolRendererPatch,
    configureThirdPartyToolRendererPatch,
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

type FakeCallRenderer = ThirdPartyToolRenderer["renderCall"];
type FakeResultRenderer = ThirdPartyToolRenderer["renderResult"];

type FakeRenderContext = {
    readonly args: unknown;
    readonly toolCallId: string;
    readonly executionStarted: boolean;
    readonly argsComplete: boolean;
    readonly isPartial: boolean;
    readonly expanded: boolean;
    readonly showImages: boolean;
    readonly isError: boolean;
};

type FakeToolExecutionInstance = {
    readonly toolName: string;
    readonly builtInToolDefinition?: unknown;
    readonly toolDefinition?: unknown;
    readonly executionStarted?: boolean;
    readonly result?: unknown;
};

type FakeToolExecutionPrototype = {
    getCallRenderer(this: object): FakeCallRenderer | undefined;
    getResultRenderer(this: object): FakeResultRenderer | undefined;
    getRenderShell(this: object): "default" | "self";
    hasRendererDefinition(this: object): boolean;
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
    it("renders built-in tool names through a render-only patch", () => {
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
            builtInToolDefinition: {},
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
        let receivedResult: unknown;
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
        let receivedResult: unknown = "unset";
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
        const originalGetCallRenderer = Reflect.get(prototype, "getCallRenderer");
        const originalGetResultRenderer = Reflect.get(prototype, "getResultRenderer");
        const originalGetRenderShell = Reflect.get(prototype, "getRenderShell");
        const originalHasRendererDefinition = Reflect.get(prototype, "hasRendererDefinition");
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

        expect(Reflect.get(prototype, "getCallRenderer")).toBe(originalGetCallRenderer);
        expect(Reflect.get(prototype, "getResultRenderer")).toBe(originalGetResultRenderer);
        expect(Reflect.get(prototype, "getRenderShell")).toBe(originalGetRenderShell);
        expect(Reflect.get(prototype, "hasRendererDefinition")).toBe(originalHasRendererDefinition);
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
                    parseArgs(value: unknown) {
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
                    parseArgs(value: unknown) {
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
        const originalGetCallRenderer = Reflect.get(prototype, "getCallRenderer");
        const originalGetResultRenderer = Reflect.get(prototype, "getResultRenderer");
        const originalGetRenderShell = Reflect.get(prototype, "getRenderShell");
        const originalHasRendererDefinition = Reflect.get(prototype, "hasRendererDefinition");
        const instance: FakeToolExecutionInstance = {
            toolName: "custom_tool",
            toolDefinition: {},
        };

        configureThirdPartyToolRendererPatch(true, undefined, prototype);
        expect(prototype.getRenderShell.call(instance)).toBe("self");

        configureThirdPartyToolRendererPatch(false, undefined, prototype);

        expect(Reflect.get(prototype, "getCallRenderer")).toBe(originalGetCallRenderer);
        expect(Reflect.get(prototype, "getResultRenderer")).toBe(originalGetResultRenderer);
        expect(Reflect.get(prototype, "getRenderShell")).toBe(originalGetRenderShell);
        expect(Reflect.get(prototype, "hasRendererDefinition")).toBe(originalHasRendererDefinition);
        expect(prototype.getRenderShell.call(instance)).toBe("default");
    });

    it("disables third-party behavior without clobbering later wrappers", () => {
        const prototype = createPrototype();
        const instance: FakeToolExecutionInstance = {
            toolName: "custom_tool",
            toolDefinition: {},
        };

        configureThirdPartyToolRendererPatch(true, undefined, prototype);
        const originalGetCallRenderer = Reflect.get(prototype, "getCallRenderer");
        if (typeof originalGetCallRenderer !== "function") {
            throw new Error("expected Glowup call renderer wrapper");
        }
        prototype.getCallRenderer = function getLaterCallRenderer(this: object) {
            return originalGetCallRenderer.call(this);
        };
        const laterGetCallRenderer = Reflect.get(prototype, "getCallRenderer");

        configureThirdPartyToolRendererPatch(false, undefined, prototype);

        expect(Reflect.get(prototype, "getCallRenderer")).toBe(laterGetCallRenderer);
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
        const patchedGetCallRenderer = Reflect.get(prototype, "getCallRenderer");
        installThirdPartyToolRendererPatch(undefined, prototype);

        expect(Reflect.get(prototype, "getCallRenderer")).toBe(patchedGetCallRenderer);
    });

    it("refreshes preserve-tool options on repeat installs without stacking wrappers", () => {
        const prototype = createPrototype();
        const instance: FakeToolExecutionInstance = {
            toolName: "custom_tool",
            toolDefinition: {},
        };

        installThirdPartyToolRendererPatch(undefined, prototype);
        const patchedGetCallRenderer = Reflect.get(prototype, "getCallRenderer");
        expect(prototype.getRenderShell.call(instance)).toBe("self");

        installThirdPartyToolRendererPatch({ preserveTools: ["custom_tool"] }, prototype);

        expect(Reflect.get(prototype, "getCallRenderer")).toBe(patchedGetCallRenderer);
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
});
