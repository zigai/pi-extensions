import {
    ToolExecutionComponent,
    type AgentToolResult,
    type Theme,
    type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import Type from "typebox";
import { Value } from "typebox/value";
import { jsonValueParser } from "../../json-value.ts";
import { emptyComponent } from "../../rendering/component.ts";
import type {
    BuiltInToolRenderContext,
    BuiltInToolRendererOptions,
    PiRendererDefinition,
    PiToolRenderContext,
    ToolCallArguments,
    ToolExecutionInstance,
} from "../../tools/built-in/context.ts";
import {
    canonicalBuiltInToolName,
    compatBuiltInToolName,
    nativeBuiltInToolName,
    type BuiltInToolName,
} from "../../tools/built-in/names.ts";
import {
    createThirdPartyToolRenderer,
    hasGlowupRenderingAdapter,
    hasThirdPartyToolRendererPlugin,
    shouldPreserveThirdPartyToolRenderer,
} from "../../tools/renderers.ts";
import {
    executionPhase,
    type ThirdPartyToolRenderContext,
    type ThirdPartyToolRenderer,
    type ThirdPartyToolRenderingOptions,
    type ThirdPartyToolResult,
} from "../../tools/types.ts";

const BUILT_IN_RENDERER_PATCH_STATE_KEY = Symbol.for("zigai.pi-glowup.built-in-renderer-state");
const THIRD_PARTY_RENDERER_PATCH_STATE_KEY = Symbol.for(
    "zigai.pi-glowup.third-party-renderer-state",
);
const MAX_THIRD_PARTY_RENDERERS = 100;

type RenderShellMode = NonNullable<PiRendererDefinition["renderShell"]>;
type ThemeForeground = Parameters<Theme["fg"]>[0];
type ThemeBackground = Parameters<Theme["bg"]>[0];
type ToolExecutionPrototypeOwner = typeof ToolExecutionComponent.prototype | ToolExecutionPrototype;
type ToolCallRenderer = NonNullable<PiRendererDefinition["renderCall"]>;
type ToolResultRenderer = NonNullable<PiRendererDefinition["renderResult"]>;

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
    return toolName !== "edit";
}

function shouldCacheThirdPartyCompletedLines(toolName: string): boolean {
    if (toolName === "apply_patch") return false;
    return canonicalBuiltInToolName(toolName) !== "edit";
}

type ToolExecutionPrototypeMethods = {
    getCallRenderer?: (this: ToolExecutionInstance) => ToolCallRenderer | undefined;
    getResultRenderer?: (this: ToolExecutionInstance) => ToolResultRenderer | undefined;
    getRenderShell?: (this: ToolExecutionInstance) => RenderShellMode;
    hasRendererDefinition?: (this: ToolExecutionInstance) => boolean;
};

type ToolExecutionPatchMetadata = object & {
    [BUILT_IN_RENDERER_PATCH_STATE_KEY]?: BuiltInRendererPatchState;
    [THIRD_PARTY_RENDERER_PATCH_STATE_KEY]?: ThirdPartyRendererPatchState;
};

type ToolExecutionPrototype = ToolExecutionPrototypeMethods & ToolExecutionPatchMetadata;

const prototypeMethodsSchema = Type.Object({
    getCallRenderer: Type.Optional(Type.Function([], Type.Unknown())),
    getResultRenderer: Type.Optional(Type.Function([], Type.Unknown())),
    getRenderShell: Type.Optional(Type.Function([], Type.Unknown())),
    hasRendererDefinition: Type.Optional(Type.Function([], Type.Unknown())),
});

/** The only bridge across Pi's erased private getter declarations. */
function checkedToolExecutionPrototype(owner: ToolExecutionPrototypeOwner): ToolExecutionPrototype {
    if (Value.Errors(prototypeMethodsSchema, owner).length !== 0) {
        throw new TypeError("Invalid Pi tool execution prototype methods");
    }
    // SAFETY: Explicit owners already implement ToolExecutionPrototype. The other union
    // member is Pi's concrete prototype: its private getters return the constructor's
    // renderer-pair fields. ToolExecutionInstance.toolDefinition derives from that same
    // constructor owner, including renderShell (which the getter defaults to "default").
    // We do not specialize schema-specific callbacks to an arbitrary parameter schema.
    // The SDK .d.ts erases those getter signatures, so TS cannot express this bridge.
    // Checks above reject non-callable optional methods without invoking a row getter.
    // Symbol state belongs exclusively to the two installers below; never clone the owner
    // or wrap its methods, since restoration and completed-render caching use identity.
    // Optional owned metadata needs no assertion; only the four erased methods do.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Pi erases private renderer signatures; checked slots follow the SDK constructor contract.
    return owner as ToolExecutionPrototypeMethods;
}

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
    "scrollbarTrack",
    "scrollbarThumb",
    "searchMatchText",
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
    "searchMatchBg",
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
        if (oldest.done === true) return;
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
    args: ToolCallArguments,
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

function builtInToolName(instance: ToolExecutionInstance): BuiltInToolName | undefined {
    const toolName = instanceToolName(instance);
    if (toolName === undefined) {
        return undefined;
    }

    // Pi resolves built-in renderers into toolDefinition before constructing the row.
    return nativeBuiltInToolName(toolName) ?? compatBuiltInToolName(toolName);
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
        args: jsonValueParser.parse(context.args),
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
    const definition = instance.toolDefinition;
    return definition?.renderCall !== undefined || definition?.renderResult !== undefined;
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

    const definition = instance.toolDefinition;

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

    return nativeBuiltInToolName(toolName) === undefined && !hasOriginalRendererDefinition;
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

    const definition = instance.toolDefinition;
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
    prototypeOwner: ToolExecutionPrototypeOwner = ToolExecutionComponent.prototype,
): void {
    const prototype = checkedToolExecutionPrototype(prototypeOwner);
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
    const observeRow = (row: ToolExecutionInstance): void => {
        // Constructors run ahead of argument completion. Observing boundaries there
        // would precede deferred exploration renders and merge runs across a boundary.
        // Pi completes live arguments in source order; restored rows become ready when
        // their persisted result is replayed (without ever setting argsComplete).
        const ready =
            row.argsComplete === true || row.executionStarted === true || row.result !== undefined;
        if (state.enabled && ready && row.toolCallId !== undefined && row.toolName !== undefined) {
            state.renderingOptions.observeRow?.(row, row.toolCallId, row.toolName);
        }
    };

    const getCallRenderer: RendererPatchWrappers["getCallRenderer"] =
        function getGlowupBuiltInCallRenderer(this: ToolExecutionInstance) {
            observeRow(this);

            const toolName = builtInToolName(this);
            const originalRenderer = originalGetCallRenderer?.call(this);
            if (!state.enabled || toolName === undefined) {
                return originalRenderer;
            }

            const result = currentToolResult(this);
            return (args: ToolCallArguments, theme: Theme, context: BuiltInToolRenderContext) => {
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

            return (
                result: AgentToolResult<unknown>,
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
            observeRow(this);
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
    prototypeOwner: ToolExecutionPrototypeOwner = ToolExecutionComponent.prototype,
): ToolRendererPatchStats {
    const prototype = checkedToolExecutionPrototype(prototypeOwner);
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

    if (
        prototype.getCallRenderer !== state.wrappers.getCallRenderer ||
        prototype.getResultRenderer !== state.wrappers.getResultRenderer ||
        prototype.getRenderShell !== state.wrappers.getRenderShell ||
        prototype.hasRendererDefinition !== state.wrappers.hasRendererDefinition
    )
        return;

    restoreGetCallRenderer(prototype, state.originalGetCallRenderer);
    restoreGetResultRenderer(prototype, state.originalGetResultRenderer);
    restoreGetRenderShell(prototype, state.originalGetRenderShell);
    restoreHasRendererDefinition(prototype, state.originalHasRendererDefinition);
    delete prototype[BUILT_IN_RENDERER_PATCH_STATE_KEY];
}

/** Enables, updates, or disables Glowup fallback renderers for non-native tools. */
export function configureThirdPartyToolRendererPatch(
    enabled: boolean,
    options?: ThirdPartyToolRenderingOptions,
    prototypeOwner: ToolExecutionPrototypeOwner = ToolExecutionComponent.prototype,
): void {
    const prototype = checkedToolExecutionPrototype(prototypeOwner);
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

                    return (
                        args: ToolCallArguments,
                        theme: Theme,
                        context: BuiltInToolRenderContext,
                    ) => {
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
                                    jsonValueParser.parse(args),
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
}

function restoreThirdPartyRendererPatch(
    prototype: ToolExecutionPrototype,
    state: ThirdPartyRendererPatchState,
): void {
    state.enabled = false;
    clearCompletedLineCache();
    state.rendererCache.clear();

    if (
        prototype.getCallRenderer !== state.wrappers.getCallRenderer ||
        prototype.getResultRenderer !== state.wrappers.getResultRenderer ||
        prototype.getRenderShell !== state.wrappers.getRenderShell ||
        prototype.hasRendererDefinition !== state.wrappers.hasRendererDefinition
    )
        return;

    restoreGetCallRenderer(prototype, state.originalGetCallRenderer);
    restoreGetResultRenderer(prototype, state.originalGetResultRenderer);
    restoreGetRenderShell(prototype, state.originalGetRenderShell);
    restoreHasRendererDefinition(prototype, state.originalHasRendererDefinition);
    delete prototype[THIRD_PARTY_RENDERER_PATCH_STATE_KEY];
}
