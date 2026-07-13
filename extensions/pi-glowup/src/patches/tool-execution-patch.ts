import {
    ToolExecutionComponent,
    type Theme,
    type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
    emptyComponent,
    formatPathTarget,
    renderCodexCall,
    renderCodexOutput,
} from "../rendering/core.ts";
import { detectStructuredOutputLanguage } from "../syntax/code-component.ts";
import {
    createThirdPartyToolRenderer,
    hasThirdPartyToolRendererPlugin,
    hasCodexLookRenderingAdapter,
    shouldPreserveThirdPartyToolRenderer,
    type ThirdPartyToolRenderer,
    type ThirdPartyToolRenderContext,
    type ThirdPartyToolRenderingOptions,
    type ThirdPartyToolResult,
} from "../third-party-tools/renderers.ts";

const BUILT_IN_RENDERER_PATCH_KEY = Symbol.for("zigai.pi-codex-look.built-in-renderers");
const BUILT_IN_RENDERER_PATCH_STATE_KEY = Symbol.for("zigai.pi-codex-look.built-in-renderer-state");
const THIRD_PARTY_RENDERER_PATCH_KEY = Symbol.for("zigai.pi-codex-look.third-party-renderers");
const THIRD_PARTY_RENDERER_PATCH_STATE_KEY = Symbol.for(
    "zigai.pi-codex-look.third-party-renderer-state",
);
const WRITE_RENDERER_PATCH_KEY = Symbol.for("zigai.pi-codex-look.write-renderer");
const MAX_THIRD_PARTY_RENDERERS = 100;

type RenderShellMode = "default" | "self";

type ToolExecutionInstance = object;

export type BuiltInToolName =
    | "read"
    | "bash"
    | "edit"
    | "write"
    | "find"
    | "grep"
    | "ls"
    | "delete"
    | "webSearch";

export type BuiltInToolRenderContext = ThirdPartyToolRenderContext & {
    readonly invalidate: () => void;
    readonly lastComponent: Component | undefined;
    readonly state: unknown;
    readonly cwd: string;
};

type ToolCallRenderer = (
    args: unknown,
    theme: Theme,
    context: BuiltInToolRenderContext,
) => Component;
type ToolResultRenderer = (
    result: ThirdPartyToolResult,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: BuiltInToolRenderContext,
) => Component;

export type BuiltInToolRendererOptions = {
    readonly renderCall: (
        toolName: BuiltInToolName,
        args: unknown,
        theme: Theme,
        context: BuiltInToolRenderContext,
    ) => Component | undefined;
    readonly renderResult: (
        toolName: BuiltInToolName,
        result: ThirdPartyToolResult,
        options: ToolRenderResultOptions,
        theme: Theme,
        context: BuiltInToolRenderContext,
    ) => Component | undefined;
};

type RendererPatchWrappers = {
    readonly getCallRenderer: NonNullable<ToolExecutionPrototype["getCallRenderer"]>;
    readonly getResultRenderer: NonNullable<ToolExecutionPrototype["getResultRenderer"]>;
    readonly getRenderShell: NonNullable<ToolExecutionPrototype["getRenderShell"]>;
    readonly hasRendererDefinition: NonNullable<ToolExecutionPrototype["hasRendererDefinition"]>;
};

type BuiltInRendererPatchState = {
    enabled: boolean;
    renderingOptions: BuiltInToolRendererOptions;
    readonly originalGetCallRenderer: ToolExecutionPrototype["getCallRenderer"];
    readonly originalGetResultRenderer: ToolExecutionPrototype["getResultRenderer"];
    readonly originalGetRenderShell: ToolExecutionPrototype["getRenderShell"];
    readonly originalHasRendererDefinition: ToolExecutionPrototype["hasRendererDefinition"];
    readonly wrappers: RendererPatchWrappers;
};

type ThirdPartyRendererPatchState = {
    enabled: boolean;
    renderingOptions: ThirdPartyToolRenderingOptions | undefined;
    readonly rendererCache: Map<
        string,
        { readonly definition: unknown; readonly renderer: ThirdPartyToolRenderer }
    >;
    readonly originalGetCallRenderer: ToolExecutionPrototype["getCallRenderer"];
    readonly originalGetResultRenderer: ToolExecutionPrototype["getResultRenderer"];
    readonly originalGetRenderShell: ToolExecutionPrototype["getRenderShell"];
    readonly originalHasRendererDefinition: ToolExecutionPrototype["hasRendererDefinition"];
    readonly wrappers: RendererPatchWrappers;
};

function nativeBuiltInToolName(toolName: string): BuiltInToolName | undefined {
    switch (toolName) {
        case "read":
        case "bash":
        case "edit":
        case "write":
        case "find":
        case "grep":
        case "ls":
            return toolName;
        default:
            return undefined;
    }
}

/** Returns the Codex-look renderer family for Pi/Cursor/Grok-compatible tool names. */
export function compatBuiltInToolName(toolName: string): BuiltInToolName | undefined {
    switch (toolName) {
        case "Read":
            return "read";
        case "Write":
            return "write";
        case "StrReplace":
        case "Edit":
            return "edit";
        case "Delete":
            return "delete";
        case "LS":
            return "ls";
        case "Grep":
            return "grep";
        case "Glob":
            return "find";
        case "Shell":
            return "bash";
        case "WebSearch":
            return "webSearch";
        default:
            return undefined;
    }
}

type ToolExecutionPrototype = {
    getCallRenderer?: (this: ToolExecutionInstance) => ToolCallRenderer | undefined;
    getResultRenderer?: (this: ToolExecutionInstance) => ToolResultRenderer | undefined;
    getRenderShell?: (this: ToolExecutionInstance) => RenderShellMode;
    hasRendererDefinition?: (this: ToolExecutionInstance) => boolean;
    [BUILT_IN_RENDERER_PATCH_KEY]?: true;
    [BUILT_IN_RENDERER_PATCH_STATE_KEY]?: BuiltInRendererPatchState;
    [THIRD_PARTY_RENDERER_PATCH_KEY]?: true;
    [THIRD_PARTY_RENDERER_PATCH_STATE_KEY]?: ThirdPartyRendererPatchState;
    [WRITE_RENDERER_PATCH_KEY]?: true;
};

function getStringField(instance: ToolExecutionInstance, fieldName: string): string | undefined {
    const value = Reflect.get(instance, fieldName);
    return typeof value === "string" ? value : undefined;
}

function getNonEmptyStringField(
    instance: ToolExecutionInstance,
    fieldName: string,
): string | undefined {
    const value = getStringField(instance, fieldName);
    return value === undefined || value.length === 0 ? undefined : value;
}

function hasBuiltInToolDefinition(instance: ToolExecutionInstance): boolean {
    return Reflect.get(instance, "builtInToolDefinition") !== undefined;
}

function builtInToolName(instance: ToolExecutionInstance): BuiltInToolName | undefined {
    const toolName = getNonEmptyStringField(instance, "toolName");
    if (toolName === undefined) {
        return undefined;
    }

    const nativeName = nativeBuiltInToolName(toolName);
    if (nativeName !== undefined) {
        return hasBuiltInToolDefinition(instance) ? nativeName : undefined;
    }

    return compatBuiltInToolName(toolName);
}

function toolDefinition(instance: ToolExecutionInstance): unknown {
    return Reflect.get(instance, "toolDefinition");
}

function currentToolResult(instance: ToolExecutionInstance): ThirdPartyToolResult | undefined {
    const result = Reflect.get(instance, "result");
    if (typeof result !== "object" || result === null) return undefined;
    return {
        content: Reflect.get(result, "content"),
        details: Reflect.get(result, "details"),
    };
}

function hasExplicitToolRenderer(instance: ToolExecutionInstance): boolean {
    for (const definition of [
        toolDefinition(instance),
        Reflect.get(instance, "builtInToolDefinition"),
    ]) {
        if (
            typeof definition === "object" &&
            definition !== null &&
            (typeof Reflect.get(definition, "renderCall") === "function" ||
                typeof Reflect.get(definition, "renderResult") === "function")
        ) {
            return true;
        }
    }
    return false;
}

function shouldUseThirdPartyRenderer(
    instance: ToolExecutionInstance,
    options: ThirdPartyToolRenderingOptions | undefined,
    hasOriginalRendererDefinition: boolean,
): boolean {
    const toolName = getNonEmptyStringField(instance, "toolName");
    if (toolName === undefined) {
        return false;
    }

    const definition = toolDefinition(instance);

    const preserveInput =
        options === undefined
            ? { toolName, toolDefinition: definition }
            : { toolName, toolDefinition: definition, renderingOptions: options };

    if (shouldPreserveThirdPartyToolRenderer(preserveInput)) {
        return false;
    }

    if (hasCodexLookRenderingAdapter(definition)) {
        return true;
    }

    if (hasThirdPartyToolRendererPlugin(toolName, options)) {
        return true;
    }

    return !hasBuiltInToolDefinition(instance) && !hasOriginalRendererDefinition;
}

function rendererForInstance(
    instance: ToolExecutionInstance,
    options: ThirdPartyToolRenderingOptions | undefined,
    cache?: Map<
        string,
        { readonly definition: unknown; readonly renderer: ThirdPartyToolRenderer }
    >,
): ThirdPartyToolRenderer | undefined {
    const toolName = getNonEmptyStringField(instance, "toolName");
    if (toolName === undefined) {
        return undefined;
    }

    const definition = toolDefinition(instance);
    const cachedRenderer = cache?.get(toolName);
    if (cachedRenderer !== undefined && cachedRenderer.definition === definition) {
        return cachedRenderer.renderer;
    }

    const renderer = createThirdPartyToolRenderer(toolName, options, definition);
    cache?.set(toolName, { definition, renderer });
    trimRendererCache(cache);
    return renderer;
}

function trimRendererCache(
    cache:
        | Map<string, { readonly definition: unknown; readonly renderer: ThirdPartyToolRenderer }>
        | undefined,
): void {
    if (cache === undefined) {
        return;
    }

    while (cache.size > MAX_THIRD_PARTY_RENDERERS) {
        const oldestToolName = cache.keys().next().value;
        if (typeof oldestToolName !== "string") {
            return;
        }
        cache.delete(oldestToolName);
    }
}

type TextContent = {
    readonly type?: unknown;
    readonly text?: unknown;
};

function resultText(result: { readonly content?: unknown }): string | undefined {
    const content = result.content;
    if (!Array.isArray(content)) {
        return undefined;
    }

    let firstText: string | undefined;
    let texts: string[] | undefined;
    for (const item of content) {
        if (
            typeof item !== "object" ||
            item === null ||
            !("type" in item) ||
            item.type !== "text"
        ) {
            continue;
        }
        const contentItem: TextContent = item;
        if (typeof contentItem.text !== "string" || contentItem.text.length === 0) {
            continue;
        }
        if (firstText === undefined) {
            firstText = contentItem.text;
            continue;
        }
        texts ??= [firstText];
        texts.push(contentItem.text);
    }

    return texts === undefined ? firstText : texts.join("\n");
}

function isWriteToolInstance(instance: ToolExecutionInstance): boolean {
    return getStringField(instance, "toolName") === "write" && hasBuiltInToolDefinition(instance);
}

const writeCallRenderer: ThirdPartyToolRenderer["renderCall"] = (args, theme, context) => {
    const record = typeof args === "object" && args !== null ? args : undefined;
    const path = record === undefined ? undefined : Reflect.get(record, "path");
    return renderCodexCall(theme, {
        state: context.isError ? "error" : context.isPartial ? "muted" : "success",
        statusText: "Write",
        body: formatPathTarget(theme, typeof path === "string" ? path : undefined),
    });
};

const writeResultRenderer: ThirdPartyToolRenderer["renderResult"] = (result, options, theme) => {
    const output = resultText(result);
    const language = detectStructuredOutputLanguage(output);
    return renderCodexOutput(theme, output, {
        expanded: options.expanded,
        mode: "head",
        maxPreviewLines: 5,
        ...(language === undefined ? {} : { syntax: { language } }),
    });
};

/** Enables, updates, or disables render-only Codex-look renderers for built-in tool names. */
export function configureBuiltInToolRendererPatch(
    enabled: boolean,
    options?: BuiltInToolRendererOptions,
    prototype: ToolExecutionPrototype = ToolExecutionComponent.prototype as unknown as ToolExecutionPrototype,
): void {
    const existingState = prototype[BUILT_IN_RENDERER_PATCH_STATE_KEY];
    if (!enabled) {
        if (existingState !== undefined) {
            restoreBuiltInRendererPatch(prototype, existingState);
        }
        return;
    }

    if (options === undefined) {
        return;
    }

    if (existingState !== undefined) {
        existingState.enabled = true;
        existingState.renderingOptions = options;
        return;
    }

    const originalGetCallRenderer = prototype.getCallRenderer;
    const originalGetResultRenderer = prototype.getResultRenderer;
    const originalGetRenderShell = prototype.getRenderShell;
    const originalHasRendererDefinition = prototype.hasRendererDefinition;
    let state: BuiltInRendererPatchState;

    const getCallRenderer: RendererPatchWrappers["getCallRenderer"] =
        function getCodexLookBuiltInCallRenderer(this: ToolExecutionInstance) {
            const toolName = builtInToolName(this);
            const originalRenderer = originalGetCallRenderer?.call(this);
            if (!state.enabled || toolName === undefined) {
                return originalRenderer;
            }
            const result = currentToolResult(this);
            return (args, theme, context) => {
                const rendered = state.renderingOptions.renderCall(toolName, args, theme, {
                    ...context,
                    ...(result === undefined ? {} : { result }),
                });
                return rendered ?? originalRenderer?.(args, theme, context) ?? emptyComponent();
            };
        };

    const getResultRenderer: RendererPatchWrappers["getResultRenderer"] =
        function getCodexLookBuiltInResultRenderer(this: ToolExecutionInstance) {
            const toolName = builtInToolName(this);
            const originalRenderer = originalGetResultRenderer?.call(this);
            if (!state.enabled || toolName === undefined) {
                return originalRenderer;
            }
            return (result, renderOptions, theme, context) =>
                state.renderingOptions.renderResult(
                    toolName,
                    result,
                    renderOptions,
                    theme,
                    context,
                ) ??
                originalRenderer?.(result, renderOptions, theme, context) ??
                emptyComponent();
        };

    const getRenderShell: RendererPatchWrappers["getRenderShell"] =
        function getCodexLookBuiltInRenderShell(this: ToolExecutionInstance) {
            return state.enabled && builtInToolName(this) !== undefined
                ? "self"
                : (originalGetRenderShell?.call(this) ?? "default");
        };

    const hasRendererDefinition: RendererPatchWrappers["hasRendererDefinition"] =
        function hasCodexLookBuiltInRendererDefinition(this: ToolExecutionInstance) {
            return state.enabled && builtInToolName(this) !== undefined
                ? true
                : (originalHasRendererDefinition?.call(this) ?? false);
        };

    state = {
        enabled: true,
        renderingOptions: options,
        originalGetCallRenderer,
        originalGetResultRenderer,
        originalGetRenderShell,
        originalHasRendererDefinition,
        wrappers: {
            getCallRenderer,
            getResultRenderer,
            getRenderShell,
            hasRendererDefinition,
        },
    };
    prototype[BUILT_IN_RENDERER_PATCH_STATE_KEY] = state;
    prototype.getCallRenderer = getCallRenderer;
    prototype.getResultRenderer = getResultRenderer;
    prototype.getRenderShell = getRenderShell;
    prototype.hasRendererDefinition = hasRendererDefinition;
    prototype[BUILT_IN_RENDERER_PATCH_KEY] = true;
}

/** Returns renderer patch state sizes for memory diagnostics. */
export function toolRendererPatchStats(
    prototype: ToolExecutionPrototype = ToolExecutionComponent.prototype as unknown as ToolExecutionPrototype,
): {
    readonly builtInPatchEnabled: boolean;
    readonly thirdPartyPatchEnabled: boolean;
    readonly thirdPartyRendererCacheEntries: number;
} {
    const builtInState = prototype[BUILT_IN_RENDERER_PATCH_STATE_KEY];
    const thirdPartyState = prototype[THIRD_PARTY_RENDERER_PATCH_STATE_KEY];
    return {
        builtInPatchEnabled: builtInState?.enabled === true,
        thirdPartyPatchEnabled: thirdPartyState?.enabled === true,
        thirdPartyRendererCacheEntries: thirdPartyState?.rendererCache.size ?? 0,
    };
}

/** Installs render-only Codex-look renderers for built-in tool names. */
export function installBuiltInToolRendererPatch(
    options: BuiltInToolRendererOptions,
    prototype: ToolExecutionPrototype = ToolExecutionComponent.prototype as unknown as ToolExecutionPrototype,
): void {
    configureBuiltInToolRendererPatch(true, options, prototype);
}

function restoreGetCallRenderer(
    prototype: ToolExecutionPrototype,
    method: ToolExecutionPrototype["getCallRenderer"],
): void {
    if (method === undefined) {
        delete prototype.getCallRenderer;
        return;
    }
    prototype.getCallRenderer = method;
}

function restoreGetResultRenderer(
    prototype: ToolExecutionPrototype,
    method: ToolExecutionPrototype["getResultRenderer"],
): void {
    if (method === undefined) {
        delete prototype.getResultRenderer;
        return;
    }
    prototype.getResultRenderer = method;
}

function restoreGetRenderShell(
    prototype: ToolExecutionPrototype,
    method: ToolExecutionPrototype["getRenderShell"],
): void {
    if (method === undefined) {
        delete prototype.getRenderShell;
        return;
    }
    prototype.getRenderShell = method;
}

function restoreHasRendererDefinition(
    prototype: ToolExecutionPrototype,
    method: ToolExecutionPrototype["hasRendererDefinition"],
): void {
    if (method === undefined) {
        delete prototype.hasRendererDefinition;
        return;
    }
    prototype.hasRendererDefinition = method;
}

function restoreBuiltInRendererPatch(
    prototype: ToolExecutionPrototype,
    state: BuiltInRendererPatchState,
): void {
    state.enabled = false;
    let restoredOwnWrappers = true;
    if (prototype.getCallRenderer === state.wrappers.getCallRenderer) {
        restoreGetCallRenderer(prototype, state.originalGetCallRenderer);
    } else {
        restoredOwnWrappers = false;
    }
    if (prototype.getResultRenderer === state.wrappers.getResultRenderer) {
        restoreGetResultRenderer(prototype, state.originalGetResultRenderer);
    } else {
        restoredOwnWrappers = false;
    }
    if (prototype.getRenderShell === state.wrappers.getRenderShell) {
        restoreGetRenderShell(prototype, state.originalGetRenderShell);
    } else {
        restoredOwnWrappers = false;
    }
    if (prototype.hasRendererDefinition === state.wrappers.hasRendererDefinition) {
        restoreHasRendererDefinition(prototype, state.originalHasRendererDefinition);
    } else {
        restoredOwnWrappers = false;
    }

    if (restoredOwnWrappers) {
        delete prototype[BUILT_IN_RENDERER_PATCH_STATE_KEY];
        delete prototype[BUILT_IN_RENDERER_PATCH_KEY];
    }
}

/** Installs an idempotent compact renderer for Pi's built-in write tool only. */
export function installBuiltInWriteRendererPatch(
    prototype: ToolExecutionPrototype = ToolExecutionComponent.prototype as unknown as ToolExecutionPrototype,
): void {
    if (prototype[WRITE_RENDERER_PATCH_KEY] === true) {
        return;
    }

    const originalGetCallRenderer = prototype.getCallRenderer;
    const originalGetResultRenderer = prototype.getResultRenderer;
    const originalGetRenderShell = prototype.getRenderShell;
    const originalHasRendererDefinition = prototype.hasRendererDefinition;

    prototype.getCallRenderer = function getCodexLookWriteCallRenderer(
        this: ToolExecutionInstance,
    ) {
        if (isWriteToolInstance(this)) {
            return writeCallRenderer;
        }
        return originalGetCallRenderer?.call(this);
    };

    prototype.getResultRenderer = function getCodexLookWriteResultRenderer(
        this: ToolExecutionInstance,
    ) {
        if (isWriteToolInstance(this)) {
            return writeResultRenderer;
        }
        return originalGetResultRenderer?.call(this);
    };

    prototype.getRenderShell = function getCodexLookWriteRenderShell(this: ToolExecutionInstance) {
        if (isWriteToolInstance(this)) {
            return "self";
        }
        return originalGetRenderShell?.call(this) ?? "default";
    };

    prototype.hasRendererDefinition = function hasCodexLookWriteRendererDefinition(
        this: ToolExecutionInstance,
    ) {
        if (isWriteToolInstance(this)) {
            return true;
        }
        return originalHasRendererDefinition?.call(this) ?? false;
    };

    prototype[WRITE_RENDERER_PATCH_KEY] = true;
}

/** Enables, updates, or disables Codex-look fallback renderers for non-native tools. */
export function configureThirdPartyToolRendererPatch(
    enabled: boolean,
    options?: ThirdPartyToolRenderingOptions,
    prototype: ToolExecutionPrototype = ToolExecutionComponent.prototype as unknown as ToolExecutionPrototype,
): void {
    const existingState = prototype[THIRD_PARTY_RENDERER_PATCH_STATE_KEY];
    if (!enabled) {
        if (existingState !== undefined) {
            restoreThirdPartyRendererPatch(prototype, existingState);
        }
        return;
    }

    if (existingState !== undefined) {
        existingState.enabled = true;
        existingState.renderingOptions = options;
        existingState.rendererCache.clear();
        return;
    }

    const originalGetCallRenderer = prototype.getCallRenderer;
    const originalGetResultRenderer = prototype.getResultRenderer;
    const originalGetRenderShell = prototype.getRenderShell;
    const originalHasRendererDefinition = prototype.hasRendererDefinition;
    let state: ThirdPartyRendererPatchState;

    const getCallRenderer: RendererPatchWrappers["getCallRenderer"] =
        function getCodexLookCallRenderer(this: ToolExecutionInstance) {
            const hasOriginalRendererDefinition = hasExplicitToolRenderer(this);
            if (
                state.enabled &&
                shouldUseThirdPartyRenderer(
                    this,
                    state.renderingOptions,
                    hasOriginalRendererDefinition,
                )
            ) {
                const renderer = rendererForInstance(
                    this,
                    state.renderingOptions,
                    state.rendererCache,
                );
                if (renderer !== undefined) {
                    const result = currentToolResult(this);
                    return (args, theme, context) =>
                        renderer.renderCall(args, theme, {
                            ...context,
                            ...(result === undefined ? {} : { result }),
                        });
                }
            }
            return originalGetCallRenderer?.call(this);
        };

    const getResultRenderer: RendererPatchWrappers["getResultRenderer"] =
        function getCodexLookResultRenderer(this: ToolExecutionInstance) {
            const hasOriginalRendererDefinition = hasExplicitToolRenderer(this);
            if (
                state.enabled &&
                shouldUseThirdPartyRenderer(
                    this,
                    state.renderingOptions,
                    hasOriginalRendererDefinition,
                )
            ) {
                return rendererForInstance(this, state.renderingOptions, state.rendererCache)
                    ?.renderResult;
            }
            return originalGetResultRenderer?.call(this);
        };

    const getRenderShell: RendererPatchWrappers["getRenderShell"] =
        function getCodexLookRenderShell(this: ToolExecutionInstance) {
            const hasOriginalRendererDefinition = hasExplicitToolRenderer(this);
            if (
                state.enabled &&
                shouldUseThirdPartyRenderer(
                    this,
                    state.renderingOptions,
                    hasOriginalRendererDefinition,
                )
            ) {
                return "self";
            }
            return originalGetRenderShell?.call(this) ?? "default";
        };

    const hasRendererDefinition: RendererPatchWrappers["hasRendererDefinition"] =
        function hasCodexLookRendererDefinition(this: ToolExecutionInstance) {
            const hasOriginalRendererDefinition = hasExplicitToolRenderer(this);
            if (
                state.enabled &&
                shouldUseThirdPartyRenderer(
                    this,
                    state.renderingOptions,
                    hasOriginalRendererDefinition,
                )
            ) {
                return true;
            }
            return originalHasRendererDefinition?.call(this) ?? false;
        };

    state = {
        enabled: true,
        renderingOptions: options,
        rendererCache: new Map(),
        originalGetCallRenderer,
        originalGetResultRenderer,
        originalGetRenderShell,
        originalHasRendererDefinition,
        wrappers: {
            getCallRenderer,
            getResultRenderer,
            getRenderShell,
            hasRendererDefinition,
        },
    };
    prototype[THIRD_PARTY_RENDERER_PATCH_STATE_KEY] = state;
    prototype.getCallRenderer = getCallRenderer;
    prototype.getResultRenderer = getResultRenderer;
    prototype.getRenderShell = getRenderShell;
    prototype.hasRendererDefinition = hasRendererDefinition;
    prototype[THIRD_PARTY_RENDERER_PATCH_KEY] = true;
}

/** Installs an idempotent Codex-look fallback renderer for non-native tools. */
export function installThirdPartyToolRendererPatch(
    options?: ThirdPartyToolRenderingOptions,
    prototype: ToolExecutionPrototype = ToolExecutionComponent.prototype as unknown as ToolExecutionPrototype,
): void {
    configureThirdPartyToolRendererPatch(true, options, prototype);
}

function restoreThirdPartyRendererPatch(
    prototype: ToolExecutionPrototype,
    state: ThirdPartyRendererPatchState,
): void {
    state.enabled = false;
    state.rendererCache.clear();
    let restoredOwnWrappers = true;
    if (prototype.getCallRenderer === state.wrappers.getCallRenderer) {
        restoreGetCallRenderer(prototype, state.originalGetCallRenderer);
    } else {
        restoredOwnWrappers = false;
    }
    if (prototype.getResultRenderer === state.wrappers.getResultRenderer) {
        restoreGetResultRenderer(prototype, state.originalGetResultRenderer);
    } else {
        restoredOwnWrappers = false;
    }
    if (prototype.getRenderShell === state.wrappers.getRenderShell) {
        restoreGetRenderShell(prototype, state.originalGetRenderShell);
    } else {
        restoredOwnWrappers = false;
    }
    if (prototype.hasRendererDefinition === state.wrappers.hasRendererDefinition) {
        restoreHasRendererDefinition(prototype, state.originalHasRendererDefinition);
    } else {
        restoredOwnWrappers = false;
    }

    if (restoredOwnWrappers) {
        delete prototype[THIRD_PARTY_RENDERER_PATCH_STATE_KEY];
        delete prototype[THIRD_PARTY_RENDERER_PATCH_KEY];
    }
}
