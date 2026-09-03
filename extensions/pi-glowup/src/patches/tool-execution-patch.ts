import {
    ToolExecutionComponent,
    type Theme,
    type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { emptyComponent } from "../rendering/core.ts";
import {
    createThirdPartyToolRenderer,
    hasGlowupRenderingAdapter,
    hasThirdPartyToolRendererPlugin,
    shouldPreserveThirdPartyToolRenderer,
    type ThirdPartyToolRenderer,
    type ThirdPartyToolRenderContext,
    type ThirdPartyToolRenderingOptions,
    type ThirdPartyToolResult,
} from "../third-party-tools/renderers.ts";
import { executionPhase } from "../third-party-tools/types.ts";

const BUILT_IN_RENDERER_PATCH_KEY = Symbol.for("zigai.pi-glowup.built-in-renderers");
const BUILT_IN_RENDERER_PATCH_STATE_KEY = Symbol.for("zigai.pi-glowup.built-in-renderer-state");
const THIRD_PARTY_RENDERER_PATCH_KEY = Symbol.for("zigai.pi-glowup.third-party-renderers");
const THIRD_PARTY_RENDERER_PATCH_STATE_KEY = Symbol.for(
    "zigai.pi-glowup.third-party-renderer-state",
);
const MAX_THIRD_PARTY_RENDERERS = 100;

type RenderShellMode = "default" | "self";
type ThemeForeground = Parameters<Theme["fg"]>[0];
type ThemeBackground = Parameters<Theme["bg"]>[0];

type PiRendererDefinition = {
    readonly renderCall?: (...args: never[]) => Component;
    readonly renderResult?: (...args: never[]) => Component;
};

type ToolExecutionInstance = {
    readonly toolName?: string;
    readonly toolDefinition?: PiRendererDefinition;
    readonly builtInToolDefinition?: PiRendererDefinition;
    readonly executionStarted?: boolean;
    readonly result?: ThirdPartyToolResult;
};

type PiToolRenderContext = {
    readonly args: unknown;
    readonly toolCallId: string;
    readonly executionStarted: boolean;
    readonly argsComplete: boolean;
    readonly isPartial: boolean;
    readonly expanded: boolean;
    readonly showImages: boolean;
    readonly isError: boolean;
    readonly cwd?: string;
    readonly invalidate?: (() => void) | undefined;
    readonly lastComponent?: Component | undefined;
    readonly result?: ThirdPartyToolResult | undefined;
};

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

export type BuiltInToolRenderContext = PiToolRenderContext & {
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

type RenderSlot = "call" | "result";

type CompletedRender = {
    readonly component: Component;
    readonly signature: readonly unknown[];
};

type CompletedRenderSlots = {
    call?: CompletedRender;
    result?: CompletedRender;
};

type CompletedRenderCache = WeakMap<ToolExecutionInstance, CompletedRenderSlots>;

type BuiltInRendererPatchState = {
    enabled: boolean;
    renderingOptions: BuiltInToolRendererOptions;
    completedRenders: CompletedRenderCache;
    readonly originalGetCallRenderer: ToolExecutionPrototype["getCallRenderer"];
    readonly originalGetResultRenderer: ToolExecutionPrototype["getResultRenderer"];
    readonly originalGetRenderShell: ToolExecutionPrototype["getRenderShell"];
    readonly originalHasRendererDefinition: ToolExecutionPrototype["hasRendererDefinition"];
    readonly wrappers: RendererPatchWrappers;
};

type ThirdPartyRendererPatchState = {
    enabled: boolean;
    renderingOptions: ThirdPartyToolRenderingOptions | undefined;
    completedRenders: CompletedRenderCache;
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

function shouldCacheCompletedLines(toolName: BuiltInToolName): boolean {
    switch (toolName) {
        case "read":
        case "bash":
        case "find":
        case "grep":
        case "ls":
        case "write":
        case "delete":
        case "webSearch":
            return true;
        case "edit":
            return false;
    }
}

function shouldCacheThirdPartyCompletedLines(toolName: string): boolean {
    if (toolName === "apply_patch") return false;
    return canonicalBuiltInToolName(toolName) !== "edit";
}

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

/** Returns the Glowup renderer family for Pi/Cursor/Grok-compatible tool names. */
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

/** Returns a canonical built-in renderer family for native and compatible tool names. */
export function canonicalBuiltInToolName(toolName: string): BuiltInToolName | undefined {
    const nativeName = nativeBuiltInToolName(toolName);
    if (nativeName !== undefined) {
        return nativeName;
    }
    const compatibleName = compatBuiltInToolName(toolName);
    if (compatibleName !== undefined) {
        return compatibleName;
    }
    return toolName === "delete" || toolName === "webSearch" ? toolName : undefined;
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
};

const THEME_FOREGROUNDS: readonly ThemeForeground[] = [
    "accent",
    "border",
    "borderAccent",
    "borderMuted",
    "success",
    "error",
    "warning",
    "muted",
    "dim",
    "text",
    "thinkingText",
    "userMessageText",
    "customMessageText",
    "customMessageLabel",
    "toolTitle",
    "toolOutput",
    "mdHeading",
    "mdLink",
    "mdLinkUrl",
    "mdCode",
    "mdCodeBlock",
    "mdCodeBlockBorder",
    "mdQuote",
    "mdQuoteBorder",
    "mdHr",
    "mdListBullet",
    "toolDiffAdded",
    "toolDiffRemoved",
    "toolDiffContext",
    "syntaxComment",
    "syntaxKeyword",
    "syntaxFunction",
    "syntaxVariable",
    "syntaxString",
    "syntaxNumber",
    "syntaxType",
    "syntaxOperator",
    "syntaxPunctuation",
    "thinkingOff",
    "thinkingMinimal",
    "thinkingLow",
    "thinkingMedium",
    "thinkingHigh",
    "thinkingXhigh",
    "thinkingMax",
    "bashMode",
];

const THEME_BACKGROUNDS: readonly ThemeBackground[] = [
    "selectedBg",
    "scrollbarThumb",
    "userMessageBg",
    "customMessageBg",
    "toolPendingBg",
    "toolSuccessBg",
    "toolErrorBg",
];

let currentRenderTheme:
    | {
          readonly theme: Theme;
          readonly fingerprint: string;
      }
    | undefined;
let renderThemeResetQueued = false;

function renderThemeFingerprint(theme: Theme): string {
    if (currentRenderTheme?.theme === theme) {
        return currentRenderTheme.fingerprint;
    }

    const parts: string[] = [];
    for (const color of THEME_FOREGROUNDS) {
        parts.push(theme.fg(color, "x"));
    }
    for (const color of THEME_BACKGROUNDS) {
        parts.push(theme.bg(color, "x"));
    }
    const fingerprint = parts.join("\u0000");
    currentRenderTheme = { theme, fingerprint };
    if (!renderThemeResetQueued) {
        renderThemeResetQueued = true;
        queueMicrotask(() => {
            currentRenderTheme = undefined;
            renderThemeResetQueued = false;
        });
    }
    return fingerprint;
}

function sameRenderSignature(previous: readonly unknown[], current: readonly unknown[]): boolean {
    if (previous.length !== current.length) return false;
    return previous.every((value, index) => Object.is(value, current[index]));
}

const DEFAULT_COMPLETED_LINE_CACHE_BYTES = 64 * 1024 * 1024;
const DEFAULT_COMPLETED_LINE_CACHE_ENTRIES = 10_000;
const COMPLETED_LINE_CACHE_ENTRY_OVERHEAD_BYTES = 16;

export type CompletedLineCacheLimits = {
    readonly maxBytes: number;
    readonly maxEntries: number;
};

type CompletedComponentState = {
    cachedWidth: number | undefined;
    cachedLines: string[] | undefined;
};

const completedComponentBases = new WeakMap<Component, Component>();
const completedComponentStates = new WeakMap<Component, CompletedComponentState>();
const completedLineCacheLru = new Map<Component, number>();
let completedLineCacheBytes = 0;
let completedLineCacheLimitBytes = DEFAULT_COMPLETED_LINE_CACHE_BYTES;
let completedLineCacheLimitEntries = DEFAULT_COMPLETED_LINE_CACHE_ENTRIES;
let completedLineCacheEvictions = 0;
let completedLineCacheHits = 0;
let completedLineCacheMisses = 0;

function completedLinesSize(lines: readonly string[]): number {
    let bytes = lines.length * COMPLETED_LINE_CACHE_ENTRY_OVERHEAD_BYTES;
    for (const line of lines) {
        bytes += Buffer.byteLength(line, "utf8");
    }
    return bytes;
}

function releaseCompletedLineCache(component: Component): void {
    const retainedBytes = completedLineCacheLru.get(component);
    if (retainedBytes !== undefined) {
        completedLineCacheLru.delete(component);
        completedLineCacheBytes -= retainedBytes;
    }
    const state = completedComponentStates.get(component);
    if (state !== undefined) {
        state.cachedWidth = undefined;
        state.cachedLines = undefined;
    }
}

function clearCompletedLineCache(): void {
    for (const component of completedLineCacheLru.keys()) {
        const state = completedComponentStates.get(component);
        if (state !== undefined) {
            state.cachedWidth = undefined;
            state.cachedLines = undefined;
        }
    }
    completedLineCacheLru.clear();
    completedLineCacheBytes = 0;
}

function touchCompletedLineCache(component: Component): void {
    const bytes = completedLineCacheLru.get(component);
    if (bytes === undefined) return;
    completedLineCacheLru.delete(component);
    completedLineCacheLru.set(component, bytes);
}

function retainCompletedLines(
    component: Component,
    state: CompletedComponentState,
    width: number,
    lines: string[],
): void {
    releaseCompletedLineCache(component);
    const bytes = completedLinesSize(lines);
    if (bytes > completedLineCacheLimitBytes) return;

    while (
        completedLineCacheBytes + bytes > completedLineCacheLimitBytes ||
        completedLineCacheLru.size >= completedLineCacheLimitEntries
    ) {
        const oldest = completedLineCacheLru.keys().next();
        if (oldest.done) return;
        releaseCompletedLineCache(oldest.value);
        completedLineCacheEvictions += 1;
    }

    state.cachedWidth = width;
    state.cachedLines = lines;
    completedLineCacheLru.set(component, bytes);
    completedLineCacheBytes += bytes;
}

function cacheCompletedComponent(component: Component): Component {
    const base = completedComponentBases.get(component) ?? component;
    const state: CompletedComponentState = {
        cachedWidth: undefined,
        cachedLines: undefined,
    };
    const wrapper: Component = {
        render(width) {
            if (state.cachedWidth === width && state.cachedLines !== undefined) {
                completedLineCacheHits += 1;
                touchCompletedLineCache(wrapper);
                return state.cachedLines;
            }
            completedLineCacheMisses += 1;
            const lines = base.render(width);
            retainCompletedLines(wrapper, state, width, lines);
            return lines;
        },
        invalidate() {
            // Pi broadly invalidates transcript children for editor-only repaints. Semantic
            // changes replace this wrapper, while renderer invalidations clear its cache slot.
        },
    };
    completedComponentBases.set(wrapper, base);
    completedComponentStates.set(wrapper, state);
    return wrapper;
}

function releaseCompletedRender(render: CompletedRender | undefined): void {
    if (render !== undefined) {
        releaseCompletedLineCache(render.component);
    }
}

function clearCompletedRendersForInstance(
    cache: CompletedRenderCache,
    instance: ToolExecutionInstance,
): void {
    const slots = cache.get(instance);
    if (slots === undefined) return;
    releaseCompletedRender(slots.call);
    releaseCompletedRender(slots.result);
    cache.delete(instance);
}

function clearCompletedRender(
    cache: CompletedRenderCache,
    instance: ToolExecutionInstance,
    slot: RenderSlot,
): void {
    const slots = cache.get(instance);
    if (slots === undefined) return;
    releaseCompletedRender(slots[slot]);
    delete slots[slot];
    if (slots.call === undefined && slots.result === undefined) {
        cache.delete(instance);
    }
}

function renderCompletedSlot(options: {
    readonly cache: CompletedRenderCache;
    readonly instance: ToolExecutionInstance;
    readonly slot: RenderSlot;
    readonly signature: readonly unknown[] | undefined;
    readonly invalidate: () => void;
    readonly cacheLines?: boolean;
    readonly render: (invalidate: () => void) => Component;
}): Component {
    const cached = options.cache.get(options.instance)?.[options.slot];
    if (
        options.signature !== undefined &&
        cached !== undefined &&
        sameRenderSignature(cached.signature, options.signature)
    ) {
        return cached.component;
    }

    clearCompletedRender(options.cache, options.instance, options.slot);
    let rendered: Component | undefined;
    const invalidate = (): void => {
        clearCompletedRendersForInstance(options.cache, options.instance);
        rendered?.invalidate();
        options.invalidate();
    };
    rendered = options.render(invalidate);
    if (options.signature === undefined) {
        return rendered;
    }

    let component = rendered;
    if (options.cacheLines === true) {
        component = cacheCompletedComponent(rendered);
    }
    const slots = options.cache.get(options.instance) ?? {};
    slots[options.slot] = { component, signature: options.signature };
    options.cache.set(options.instance, slots);
    return component;
}

function completedCallSignature(
    args: unknown,
    theme: Theme,
    context: PiToolRenderContext,
): readonly unknown[] | undefined {
    if (context.isPartial || !context.argsComplete) return undefined;
    return [
        args,
        renderThemeFingerprint(theme),
        context.executionStarted,
        context.expanded,
        context.showImages,
        context.isError,
        context.cwd,
        context.result?.content,
        context.result?.details,
    ];
}

function completedResultSignature(
    result: ThirdPartyToolResult,
    renderOptions: ToolRenderResultOptions,
    theme: Theme,
    context: PiToolRenderContext,
): readonly unknown[] | undefined {
    if (renderOptions.isPartial) return undefined;
    return [
        context.args,
        result.content,
        result.details,
        renderOptions.expanded,
        renderThemeFingerprint(theme),
        context.executionStarted,
        context.argsComplete,
        context.showImages,
        context.isError,
        context.cwd,
    ];
}

function instanceToolName(instance: ToolExecutionInstance): string | undefined {
    const { toolName } = instance;
    return toolName === undefined || toolName.length === 0 ? undefined : toolName;
}

function hasBuiltInToolDefinition(instance: ToolExecutionInstance): boolean {
    return instance.builtInToolDefinition !== undefined;
}

function builtInToolName(instance: ToolExecutionInstance): BuiltInToolName | undefined {
    const toolName = instanceToolName(instance);
    if (toolName === undefined) {
        return undefined;
    }

    const nativeName = nativeBuiltInToolName(toolName);
    if (nativeName !== undefined) {
        return hasBuiltInToolDefinition(instance) ? nativeName : undefined;
    }

    return compatBuiltInToolName(toolName);
}

function toolDefinition(instance: ToolExecutionInstance): PiRendererDefinition | undefined {
    return instance.toolDefinition;
}

function currentToolResult(instance: ToolExecutionInstance): ThirdPartyToolResult | undefined {
    // Live results have their own renderer pass. Forwarding them into the call renderer in the
    // same frame couples transcript growth to footer/input updates; restored calls never start.
    return instance.executionStarted === true ? undefined : instance.result;
}

function restoredCallRenderContext(
    context: BuiltInToolRenderContext,
    result: ThirdPartyToolResult | undefined,
): BuiltInToolRenderContext;
function restoredCallRenderContext(
    context: BuiltInToolRenderContext,
    result: ThirdPartyToolResult | undefined,
): BuiltInToolRenderContext {
    if (result === undefined) {
        return context;
    }

    // Pi constructs restored ToolExecutionComponents with argsComplete=false, then replays the
    // persisted result without calling setArgsComplete(). A persisted result proves that the call
    // arguments are complete; preserve that fact for renderers that defer structured parsing while
    // arguments are still streaming.
    return { ...context, argsComplete: true, result };
}

function thirdPartyRenderContext(
    toolName: string,
    context: PiToolRenderContext,
): ThirdPartyToolRenderContext {
    let renderContext: ThirdPartyToolRenderContext = {
        toolName,
        toolCallId: context.toolCallId,
        phase: executionPhase(context),
        args: context.args,
        executionStarted: context.executionStarted,
        argsComplete: context.argsComplete,
        isPartial: context.isPartial,
        expanded: context.expanded,
        showImages: context.showImages,
        isError: context.isError,
    };
    if (context.cwd !== undefined) {
        renderContext = { ...renderContext, cwd: context.cwd };
    }
    if (context.invalidate !== undefined) {
        renderContext = { ...renderContext, invalidate: context.invalidate };
    }
    if (context.lastComponent !== undefined) {
        renderContext = { ...renderContext, lastComponent: context.lastComponent };
    }
    if (context.result !== undefined) {
        renderContext = { ...renderContext, result: context.result };
    }
    return renderContext;
}

function hasExplicitToolRenderer(instance: ToolExecutionInstance): boolean {
    for (const definition of [instance.toolDefinition, instance.builtInToolDefinition]) {
        if (definition?.renderCall !== undefined || definition?.renderResult !== undefined) {
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
    const toolName = instanceToolName(instance);
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

    if (hasGlowupRenderingAdapter(definition)) {
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
    const toolName = instanceToolName(instance);
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
        const oldestToolName = cache.keys().next();
        if (oldestToolName.done === true) {
            return;
        }
        cache.delete(oldestToolName.value);
    }
}

/** Updates bounded completed-output cache limits and clears retained rendered lines. */
export function configureCompletedLineCache(limits: CompletedLineCacheLimits): void {
    if (
        completedLineCacheLimitBytes === limits.maxBytes &&
        completedLineCacheLimitEntries === limits.maxEntries
    ) {
        return;
    }
    clearCompletedLineCache();
    completedLineCacheLimitBytes = limits.maxBytes;
    completedLineCacheLimitEntries = limits.maxEntries;
}

/** Enables, updates, or disables render-only Glowup renderers for built-in tool names. */
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
        clearCompletedLineCache();
        existingState.completedRenders = new WeakMap();
        return;
    }

    const originalGetCallRenderer = prototype.getCallRenderer;
    const originalGetResultRenderer = prototype.getResultRenderer;
    const originalGetRenderShell = prototype.getRenderShell;
    const originalHasRendererDefinition = prototype.hasRendererDefinition;
    let state: BuiltInRendererPatchState;

    const getCallRenderer: RendererPatchWrappers["getCallRenderer"] =
        function getGlowupBuiltInCallRenderer(this: ToolExecutionInstance) {
            const toolName = builtInToolName(this);
            const originalRenderer = originalGetCallRenderer?.call(this);
            if (!state.enabled || toolName === undefined) {
                return originalRenderer;
            }
            const result = currentToolResult(this);
            return (args, theme, context) => {
                const restoredContext = restoredCallRenderContext(context, result);
                return renderCompletedSlot({
                    cache: state.completedRenders,
                    instance: this,
                    slot: "call",
                    signature: completedCallSignature(args, theme, restoredContext),
                    invalidate: context.invalidate,
                    cacheLines: shouldCacheCompletedLines(toolName),
                    render(invalidate) {
                        const glowupContext = { ...restoredContext, invalidate };
                        const rendered = state.renderingOptions.renderCall(
                            toolName,
                            args,
                            theme,
                            glowupContext,
                        );
                        const originalContext = { ...context, invalidate };
                        return (
                            rendered ??
                            originalRenderer?.(args, theme, originalContext) ??
                            emptyComponent()
                        );
                    },
                });
            };
        };

    const getResultRenderer: RendererPatchWrappers["getResultRenderer"] =
        function getGlowupBuiltInResultRenderer(this: ToolExecutionInstance) {
            const toolName = builtInToolName(this);
            const originalRenderer = originalGetResultRenderer?.call(this);
            if (!state.enabled || toolName === undefined) {
                return originalRenderer;
            }
            return (result, renderOptions, theme, context) =>
                renderCompletedSlot({
                    cache: state.completedRenders,
                    instance: this,
                    slot: "result",
                    signature: completedResultSignature(result, renderOptions, theme, context),
                    invalidate: context.invalidate,
                    cacheLines: shouldCacheCompletedLines(toolName),
                    render(invalidate) {
                        const renderContext = { ...context, invalidate };
                        return (
                            state.renderingOptions.renderResult(
                                toolName,
                                result,
                                renderOptions,
                                theme,
                                renderContext,
                            ) ??
                            originalRenderer?.(result, renderOptions, theme, renderContext) ??
                            emptyComponent()
                        );
                    },
                });
        };

    const getRenderShell: RendererPatchWrappers["getRenderShell"] =
        function getGlowupBuiltInRenderShell(this: ToolExecutionInstance) {
            return state.enabled && builtInToolName(this) !== undefined
                ? "self"
                : (originalGetRenderShell?.call(this) ?? "default");
        };

    const hasRendererDefinition: RendererPatchWrappers["hasRendererDefinition"] =
        function hasGlowupBuiltInRendererDefinition(this: ToolExecutionInstance) {
            return state.enabled && builtInToolName(this) !== undefined
                ? true
                : (originalHasRendererDefinition?.call(this) ?? false);
        };

    state = {
        enabled: true,
        renderingOptions: options,
        completedRenders: new WeakMap(),
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

export type ToolRendererPatchStats = {
    readonly builtInPatchEnabled: boolean;
    readonly thirdPartyPatchEnabled: boolean;
    readonly thirdPartyRendererCacheEntries: number;
    readonly completedLineCacheEntries: number;
    readonly completedLineCacheBytes: number;
    readonly completedLineCacheLimitBytes: number;
    readonly completedLineCacheLimitEntries: number;
    readonly completedLineCacheEvictions: number;
    readonly completedLineCacheHits: number;
    readonly completedLineCacheMisses: number;
};

/** Returns renderer patch state sizes for memory diagnostics. */
export function toolRendererPatchStats(
    prototype: ToolExecutionPrototype = ToolExecutionComponent.prototype as unknown as ToolExecutionPrototype,
): ToolRendererPatchStats {
    const builtInState = prototype[BUILT_IN_RENDERER_PATCH_STATE_KEY];
    const thirdPartyState = prototype[THIRD_PARTY_RENDERER_PATCH_STATE_KEY];
    return {
        builtInPatchEnabled: builtInState?.enabled === true,
        thirdPartyPatchEnabled: thirdPartyState?.enabled === true,
        thirdPartyRendererCacheEntries: thirdPartyState?.rendererCache.size ?? 0,
        completedLineCacheEntries: completedLineCacheLru.size,
        completedLineCacheBytes,
        completedLineCacheLimitBytes,
        completedLineCacheLimitEntries,
        completedLineCacheEvictions,
        completedLineCacheHits,
        completedLineCacheMisses,
    };
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
    clearCompletedLineCache();
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

/** Enables, updates, or disables Glowup fallback renderers for non-native tools. */
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
        clearCompletedLineCache();
        existingState.completedRenders = new WeakMap();
        existingState.rendererCache.clear();
        return;
    }

    const originalGetCallRenderer = prototype.getCallRenderer;
    const originalGetResultRenderer = prototype.getResultRenderer;
    const originalGetRenderShell = prototype.getRenderShell;
    const originalHasRendererDefinition = prototype.hasRendererDefinition;
    let state: ThirdPartyRendererPatchState;

    const getCallRenderer: RendererPatchWrappers["getCallRenderer"] =
        function getGlowupCallRenderer(this: ToolExecutionInstance) {
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
                    const toolName = instanceToolName(this) ?? "tool";
                    return (args: unknown, theme: Theme, context: BuiltInToolRenderContext) => {
                        const restoredContext = restoredCallRenderContext(context, result);
                        return renderCompletedSlot({
                            cache: state.completedRenders,
                            instance: this,
                            slot: "call",
                            signature: completedCallSignature(args, theme, restoredContext),
                            invalidate: context.invalidate,
                            cacheLines: shouldCacheThirdPartyCompletedLines(toolName),
                            render(invalidate) {
                                return renderer.renderCall(
                                    args,
                                    theme,
                                    thirdPartyRenderContext(toolName, {
                                        ...restoredContext,
                                        invalidate,
                                    }),
                                );
                            },
                        });
                    };
                }
            }
            return originalGetCallRenderer?.call(this);
        };

    const getResultRenderer: RendererPatchWrappers["getResultRenderer"] =
        function getGlowupResultRenderer(this: ToolExecutionInstance) {
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
                const toolName = instanceToolName(this);
                if (renderer === undefined || toolName === undefined) {
                    return undefined;
                }
                return (
                    result: ThirdPartyToolResult,
                    renderOptions: ToolRenderResultOptions,
                    theme: Theme,
                    context: BuiltInToolRenderContext,
                ) =>
                    renderCompletedSlot({
                        cache: state.completedRenders,
                        instance: this,
                        slot: "result",
                        signature: completedResultSignature(result, renderOptions, theme, context),
                        invalidate: context.invalidate,
                        cacheLines: shouldCacheThirdPartyCompletedLines(toolName),
                        render(invalidate) {
                            return renderer.renderResult(
                                result,
                                renderOptions,
                                theme,
                                thirdPartyRenderContext(toolName, { ...context, invalidate }),
                            );
                        },
                    });
            }
            return originalGetResultRenderer?.call(this);
        };

    const getRenderShell: RendererPatchWrappers["getRenderShell"] = function getGlowupRenderShell(
        this: ToolExecutionInstance,
    ) {
        const hasOriginalRendererDefinition = hasExplicitToolRenderer(this);
        if (
            state.enabled &&
            shouldUseThirdPartyRenderer(this, state.renderingOptions, hasOriginalRendererDefinition)
        ) {
            return "self";
        }
        return originalGetRenderShell?.call(this) ?? "default";
    };

    const hasRendererDefinition: RendererPatchWrappers["hasRendererDefinition"] =
        function hasGlowupRendererDefinition(this: ToolExecutionInstance) {
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
        completedRenders: new WeakMap(),
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

function restoreThirdPartyRendererPatch(
    prototype: ToolExecutionPrototype,
    state: ThirdPartyRendererPatchState,
): void {
    state.enabled = false;
    clearCompletedLineCache();
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
