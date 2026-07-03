import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { formatPathTarget, renderCodexCall, renderCodexOutput } from "./rendering.ts";
import { detectStructuredOutputLanguage } from "./syntax/code-component.ts";
import {
    createThirdPartyToolRenderer,
    shouldPreserveThirdPartyToolRenderer,
    type ThirdPartyToolRenderer,
    type ThirdPartyToolRenderingOptions,
} from "./third-party-renderers.ts";

const THIRD_PARTY_RENDERER_PATCH_KEY = Symbol.for("zigai.pi-codex-look.third-party-renderers");
const THIRD_PARTY_RENDERER_PATCH_STATE_KEY = Symbol.for(
    "zigai.pi-codex-look.third-party-renderer-state",
);
const WRITE_RENDERER_PATCH_KEY = Symbol.for("zigai.pi-codex-look.write-renderer");
const MAX_THIRD_PARTY_RENDERERS = 100;

type RenderShellMode = "default" | "self";

type ToolExecutionInstance = object;

type ThirdPartyRendererPatchState = {
    renderingOptions: ThirdPartyToolRenderingOptions | undefined;
    readonly rendererCache: Map<string, ThirdPartyToolRenderer>;
};

type ToolExecutionPrototype = {
    getCallRenderer?: (
        this: ToolExecutionInstance,
    ) => ThirdPartyToolRenderer["renderCall"] | undefined;
    getResultRenderer?: (
        this: ToolExecutionInstance,
    ) => ThirdPartyToolRenderer["renderResult"] | undefined;
    getRenderShell?: (this: ToolExecutionInstance) => RenderShellMode;
    hasRendererDefinition?: (this: ToolExecutionInstance) => boolean;
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

function toolDefinition(instance: ToolExecutionInstance): unknown {
    return Reflect.get(instance, "toolDefinition");
}

function shouldUseThirdPartyRenderer(
    instance: ToolExecutionInstance,
    options: ThirdPartyToolRenderingOptions | undefined,
): boolean {
    const toolName = getNonEmptyStringField(instance, "toolName");
    if (toolName === undefined || hasBuiltInToolDefinition(instance)) {
        return false;
    }

    const preserveInput =
        options === undefined
            ? { toolName, toolDefinition: toolDefinition(instance) }
            : { toolName, toolDefinition: toolDefinition(instance), renderingOptions: options };

    return !shouldPreserveThirdPartyToolRenderer(preserveInput);
}

function rendererForInstance(
    instance: ToolExecutionInstance,
    options: ThirdPartyToolRenderingOptions | undefined,
    cache?: Map<string, ThirdPartyToolRenderer>,
): ThirdPartyToolRenderer | undefined {
    const toolName = getNonEmptyStringField(instance, "toolName");
    if (toolName === undefined) {
        return undefined;
    }

    const cachedRenderer = cache?.get(toolName);
    if (cachedRenderer !== undefined) {
        return cachedRenderer;
    }

    const renderer = createThirdPartyToolRenderer(toolName, options);
    cache?.set(toolName, renderer);
    trimRendererCache(cache);
    return renderer;
}

function trimRendererCache(cache: Map<string, ThirdPartyToolRenderer> | undefined): void {
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
        statusText: context.isPartial ? "Write" : "Wrote",
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

/** Installs an idempotent Codex-look fallback renderer for non-native tools. */
export function installThirdPartyToolRendererPatch(
    options?: ThirdPartyToolRenderingOptions,
    prototype: ToolExecutionPrototype = ToolExecutionComponent.prototype as unknown as ToolExecutionPrototype,
): void {
    const existingState = prototype[THIRD_PARTY_RENDERER_PATCH_STATE_KEY];
    if (prototype[THIRD_PARTY_RENDERER_PATCH_KEY] === true && existingState !== undefined) {
        existingState.renderingOptions = options;
        existingState.rendererCache.clear();
        return;
    }
    if (prototype[THIRD_PARTY_RENDERER_PATCH_KEY] === true) {
        return;
    }

    const originalGetCallRenderer = prototype.getCallRenderer;
    const originalGetResultRenderer = prototype.getResultRenderer;
    const originalGetRenderShell = prototype.getRenderShell;
    const originalHasRendererDefinition = prototype.hasRendererDefinition;
    const state: ThirdPartyRendererPatchState = {
        renderingOptions: options,
        rendererCache: new Map<string, ThirdPartyToolRenderer>(),
    };
    prototype[THIRD_PARTY_RENDERER_PATCH_STATE_KEY] = state;

    prototype.getCallRenderer = function getCodexLookCallRenderer(this: ToolExecutionInstance) {
        if (shouldUseThirdPartyRenderer(this, state.renderingOptions)) {
            return rendererForInstance(this, state.renderingOptions, state.rendererCache)
                ?.renderCall;
        }
        return originalGetCallRenderer?.call(this);
    };

    prototype.getResultRenderer = function getCodexLookResultRenderer(this: ToolExecutionInstance) {
        if (shouldUseThirdPartyRenderer(this, state.renderingOptions)) {
            return rendererForInstance(this, state.renderingOptions, state.rendererCache)
                ?.renderResult;
        }
        return originalGetResultRenderer?.call(this);
    };

    prototype.getRenderShell = function getCodexLookRenderShell(this: ToolExecutionInstance) {
        if (shouldUseThirdPartyRenderer(this, state.renderingOptions)) {
            return "self";
        }
        return originalGetRenderShell?.call(this) ?? "default";
    };

    prototype.hasRendererDefinition = function hasCodexLookRendererDefinition(
        this: ToolExecutionInstance,
    ) {
        if (shouldUseThirdPartyRenderer(this, state.renderingOptions)) {
            return true;
        }
        return originalHasRendererDefinition?.call(this) ?? false;
    };

    prototype[THIRD_PARTY_RENDERER_PATCH_KEY] = true;
}
