import { createApplyPatchRenderer } from "../rendering/apply-patch-rendering.ts";
import { createAgentRenderer, isAgentTool } from "./agent-renderer.ts";
import {
    createBrowserRenderer,
    createMcpToolRenderer,
    hasChromeDevtoolsName,
} from "./browser-renderers.ts";
import { createCoreRenderer, isCoreTool } from "./core-renderer.ts";
import { createGoalRenderer, isGoalTool } from "./goal-renderer.ts";
import { createGenericRenderer } from "./call-rendering.ts";
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
        name: "browser-mcp-gateway",
        matches: (toolName) => toolName === "agent_browser" || toolName === "mcp",
        createRenderer: createBrowserRenderer,
    },
    {
        name: "chrome-devtools-mcp-tools",
        matches: hasChromeDevtoolsName,
        createRenderer: createMcpToolRenderer,
    },
    {
        name: "goal-tools",
        matches: isGoalTool,
        createRenderer: createGoalRenderer,
    },
    {
        name: "codex-core-tools",
        matches: isCoreTool,
        createRenderer: createCoreRenderer,
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
): ThirdPartyToolRenderer {
    const plugins = [...(options?.renderers ?? []), ...DEFAULT_RENDERER_PLUGINS];
    const plugin = plugins.find((candidate) => candidate.matches(toolName));
    return plugin?.createRenderer(toolName) ?? createGenericRenderer(toolName);
}
