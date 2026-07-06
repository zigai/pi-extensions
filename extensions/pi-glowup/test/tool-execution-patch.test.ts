import { describe, expect, it } from "vitest";
import type { CodexRenderTheme } from "../src/rendering/core.ts";
import type {
    ThirdPartyToolRenderer,
    ThirdPartyToolRendererPlugin,
} from "../src/third-party-tools/renderers.ts";
import {
    configureBuiltInToolRendererPatch,
    configureThirdPartyToolRendererPatch,
    installBuiltInToolRendererPatch,
    installBuiltInWriteRendererPatch,
    installThirdPartyToolRendererPatch,
} from "../src/patches/tool-execution-patch.ts";

const plainTheme: CodexRenderTheme = {
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

    it("replaces only the built-in write renderer without registering a write tool override", () => {
        const prototype = createPrototype();
        installBuiltInWriteRendererPatch(prototype);

        const writeInstance: FakeToolExecutionInstance = {
            toolName: "write",
            builtInToolDefinition: {},
        };
        const readInstance: FakeToolExecutionInstance = {
            toolName: "read",
            builtInToolDefinition: {},
        };

        expect(prototype.getRenderShell.call(writeInstance)).toBe("self");
        expect(prototype.hasRendererDefinition.call(writeInstance)).toBe(true);
        expect(
            prototype.getCallRenderer
                .call(writeInstance)?.(
                    { path: "large.ts", content: "x".repeat(100_000) },
                    plainTheme,
                    renderContext,
                )
                .render(80)
                .join("\n"),
        ).toContain("Write large.ts");
        expect(
            prototype.getCallRenderer
                .call(readInstance)?.({}, plainTheme, renderContext)
                .render(80),
        ).toEqual(["existing renderer"]);
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

    it("auto-converts unknown third-party tools to self-shell Codex rendering", () => {
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
            "Called custom_tool",
        );
    });

    it("preserves native third-party renderers unless they opt in", () => {
        const prototype = createPrototype();
        prototype.hasRendererDefinition = function hasNativeRendererDefinition(): boolean {
            return true;
        };
        installThirdPartyToolRendererPatch(undefined, prototype);

        const instance: FakeToolExecutionInstance = {
            toolName: "custom_tool",
            toolDefinition: {},
        };

        expect(prototype.getRenderShell.call(instance)).toBe("default");
        expect(prototype.hasRendererDefinition.call(instance)).toBe(true);
        expect(
            prototype.getCallRenderer.call(instance)?.({}, plainTheme, renderContext).render(80),
        ).toEqual(["existing renderer"]);
    });

    it("uses passive Codex-look adapters over native third-party renderers", () => {
        const prototype = createPrototype();
        prototype.hasRendererDefinition = function hasNativeRendererDefinition(): boolean {
            return true;
        };
        installThirdPartyToolRendererPatch(undefined, prototype);

        const instance: FakeToolExecutionInstance = {
            toolName: "db_query",
            toolDefinition: {
                codexLookRendering: {
                    version: 1,
                    renderCall: () => ({
                        kind: "call",
                        label: "DB Query",
                        body: "select 1",
                    }),
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
        const codexGetCallRenderer = Reflect.get(prototype, "getCallRenderer");
        if (typeof codexGetCallRenderer !== "function") {
            throw new Error("expected Codex-look call renderer wrapper");
        }
        prototype.getCallRenderer = function getLaterCallRenderer(this: object) {
            return codexGetCallRenderer.call(this);
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
