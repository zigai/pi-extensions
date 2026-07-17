import { createApplyPatchRenderer } from "../rendering/apply-patch-rendering.ts";
import { createAgentBrowserRenderer } from "./extensions/agent-browser/renderer.ts";
import { createCodexRenderer, isCodexTool } from "./extensions/codex/renderer.ts";
import {
    createChromeDevtoolsMcpRenderer,
    createMcpGatewayRenderer,
    hasChromeDevtoolsName,
} from "./extensions/mcp-gateway/renderer.ts";
import { createAgentRenderer, isAgentTool } from "./extensions/pi/agent-renderer.ts";
import { createGoalRenderer, isGoalTool } from "./extensions/pi/goal-renderer.ts";
import { createPiCoreRenderer, isPiCoreTool } from "./extensions/pi/core-renderer.ts";
import { createGenericRenderer } from "./call-rendering.ts";
import { glowupRenderingAdapter, createProtocolRenderer } from "./protocol-renderer.ts";
import { baseToolName, isRecord } from "./tool-values.ts";
import {
    GLOWUP_RENDERING_PROPERTY,
    type ThirdPartyToolRenderer,
    type ThirdPartyToolRendererPlugin,
    type ThirdPartyToolRenderingOptions,
    type ToolNameMatcher,
} from "./types.ts";

export { GLOWUP_RENDERING_PROPERTY } from "./types.ts";
export type {
    GlowupRenderingPreference,
    ThirdPartyToolRenderContext,
    ThirdPartyToolRenderer,
    ThirdPartyToolRendererPlugin,
    ThirdPartyToolRenderingOptions,
    ThirdPartyToolResult,
    ToolNameMatcher,
} from "./types.ts";

function isApplyPatchTool(toolName: string): boolean {
    return baseToolName(toolName) === "apply_patch";
}

const DEFAULT_RENDERER_PLUGINS: ReadonlyArray<ThirdPartyToolRendererPlugin> = [
    {
        name: "apply-patch",
        matches: isApplyPatchTool,
        createRenderer: (toolName, options) =>
            createApplyPatchRenderer(toolName, options?.labelMode),
    },
    {
        name: "agent-browser",
        matches: (toolName) => toolName === "agent_browser",
        createRenderer: (toolName, options) =>
            createAgentBrowserRenderer(toolName, options?.labelMode),
    },
    {
        name: "mcp-gateway",
        matches: (toolName) => toolName === "mcp",
        createRenderer: (toolName, options) =>
            createMcpGatewayRenderer(toolName, options?.labelMode),
    },
    {
        name: "chrome-devtools-mcp-tools",
        matches: hasChromeDevtoolsName,
        createRenderer: (toolName, options) =>
            createChromeDevtoolsMcpRenderer(toolName, options?.labelMode),
    },
    {
        name: "pi-core-tools",
        matches: isPiCoreTool,
        createRenderer: (toolName, options) => createPiCoreRenderer(toolName, options?.labelMode),
    },
    {
        name: "goal-tools",
        matches: isGoalTool,
        createRenderer: (toolName, options) => createGoalRenderer(toolName, options?.labelMode),
    },
    {
        name: "codex-tools",
        matches: isCodexTool,
        createRenderer: (toolName, options) => createCodexRenderer(toolName, options?.labelMode),
    },
    {
        name: "agent-tools",
        matches: isAgentTool,
        createRenderer: (toolName, options) => createAgentRenderer(toolName, options?.labelMode),
    },
];

function rendererPlugins(
    options: ThirdPartyToolRenderingOptions | undefined,
): ReadonlyArray<ThirdPartyToolRendererPlugin> {
    return [...(options?.renderers ?? []), ...DEFAULT_RENDERER_PLUGINS];
}

/** Returns whether Glowup has an explicit renderer for this tool family. */
export function hasThirdPartyToolRendererPlugin(
    toolName: string,
    options?: ThirdPartyToolRenderingOptions,
): boolean {
    return rendererPlugins(options).some((candidate) => candidate.matches(toolName));
}

function matcherMatches(toolName: string, matcher: ToolNameMatcher): boolean {
    if (typeof matcher === "string") {
        return matcher === toolName || matcher === baseToolName(toolName);
    }
    if (matcher instanceof RegExp) {
        matcher.lastIndex = 0;
        const matchesToolName = matcher.test(toolName);
        matcher.lastIndex = 0;
        const matchesBaseName = matcher.test(baseToolName(toolName));
        matcher.lastIndex = 0;
        return matchesToolName || matchesBaseName;
    }
    return matcher(toolName);
}

function hasPreservePreference(toolDefinition: unknown): boolean {
    if (!isRecord(toolDefinition)) {
        return false;
    }
    return toolDefinition[GLOWUP_RENDERING_PROPERTY] === "preserve";
}

/** Returns whether a tool definition carries a passive Glowup adapter. */
export function hasGlowupRenderingAdapter(toolDefinition: unknown): boolean {
    return glowupRenderingAdapter(toolDefinition, GLOWUP_RENDERING_PROPERTY) !== undefined;
}

/** Parses comma-separated tool names for `PI_GLOWUP_PRESERVE_TOOLS`. */
export function parsePreservedThirdPartyToolNames(value: string | undefined): string[] {
    if (value === undefined || value.length === 0) {
        return [];
    }
    return value
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
}

/** Returns whether Glowup should leave a third-party tool renderer untouched. */
export function shouldPreserveThirdPartyToolRenderer(options: {
    readonly toolName: string;
    readonly toolDefinition: unknown;
    readonly renderingOptions?: ThirdPartyToolRenderingOptions;
}): boolean {
    if (options.renderingOptions?.enabled === false) {
        return true;
    }
    if (hasPreservePreference(options.toolDefinition)) {
        return true;
    }

    const preserveTools = options.renderingOptions?.preserveTools ?? [];
    return preserveTools.some((matcher) => matcherMatches(options.toolName, matcher));
}

/** Creates the best known Glowup renderer for a third-party tool. */
export function createThirdPartyToolRenderer(
    toolName: string,
    options?: ThirdPartyToolRenderingOptions,
    toolDefinition?: unknown,
): ThirdPartyToolRenderer {
    const plugins = rendererPlugins(options);
    const plugin = plugins.find((candidate) => candidate.matches(toolName));
    const fallback =
        plugin?.createRenderer(toolName, options) ??
        createGenericRenderer(toolName, undefined, options?.labelMode);
    const adapter = glowupRenderingAdapter(toolDefinition, GLOWUP_RENDERING_PROPERTY);
    return adapter === undefined
        ? fallback
        : createProtocolRenderer(adapter, fallback, options?.labelMode);
}
