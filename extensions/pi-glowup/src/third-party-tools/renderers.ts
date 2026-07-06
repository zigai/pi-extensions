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
import { codexLookRenderingAdapter, createProtocolRenderer } from "./protocol-renderer.ts";
import { baseToolName, isRecord } from "./tool-values.ts";
import {
    CODEX_LOOK_RENDERING_PROPERTY,
    type ThirdPartyToolRenderer,
    type ThirdPartyToolRendererPlugin,
    type ThirdPartyToolRenderingOptions,
    type ToolNameMatcher,
} from "./types.ts";

export { CODEX_LOOK_RENDERING_PROPERTY } from "./types.ts";
export type {
    CodexLookRenderingPreference,
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
        createRenderer: createApplyPatchRenderer,
    },
    {
        name: "agent-browser",
        matches: (toolName) => toolName === "agent_browser",
        createRenderer: createAgentBrowserRenderer,
    },
    {
        name: "mcp-gateway",
        matches: (toolName) => toolName === "mcp",
        createRenderer: createMcpGatewayRenderer,
    },
    {
        name: "chrome-devtools-mcp-tools",
        matches: hasChromeDevtoolsName,
        createRenderer: createChromeDevtoolsMcpRenderer,
    },
    {
        name: "pi-core-tools",
        matches: isPiCoreTool,
        createRenderer: createPiCoreRenderer,
    },
    {
        name: "goal-tools",
        matches: isGoalTool,
        createRenderer: createGoalRenderer,
    },
    {
        name: "codex-tools",
        matches: isCodexTool,
        createRenderer: createCodexRenderer,
    },
    {
        name: "agent-tools",
        matches: isAgentTool,
        createRenderer: createAgentRenderer,
    },
];

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
    return toolDefinition[CODEX_LOOK_RENDERING_PROPERTY] === "preserve";
}

/** Returns whether a tool definition carries a passive Codex-look adapter. */
export function hasCodexLookRenderingAdapter(toolDefinition: unknown): boolean {
    return codexLookRenderingAdapter(toolDefinition, CODEX_LOOK_RENDERING_PROPERTY) !== undefined;
}

/** Parses comma-separated tool names for `PI_CODEX_LOOK_PRESERVE_TOOLS`. */
export function parsePreservedThirdPartyToolNames(value: string | undefined): string[] {
    if (value === undefined || value.length === 0) {
        return [];
    }
    return value
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
}

/** Returns whether Codex-look should leave a third-party tool renderer untouched. */
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

/** Creates the best known Codex-look renderer for a third-party tool. */
export function createThirdPartyToolRenderer(
    toolName: string,
    options?: ThirdPartyToolRenderingOptions,
    toolDefinition?: unknown,
): ThirdPartyToolRenderer {
    const plugins = [...(options?.renderers ?? []), ...DEFAULT_RENDERER_PLUGINS];
    const plugin = plugins.find((candidate) => candidate.matches(toolName));
    const fallback = plugin?.createRenderer(toolName) ?? createGenericRenderer(toolName);
    const adapter = codexLookRenderingAdapter(toolDefinition, CODEX_LOOK_RENDERING_PROPERTY);
    return adapter === undefined ? fallback : createProtocolRenderer(adapter, fallback);
}
