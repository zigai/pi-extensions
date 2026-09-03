import Type, { type Static } from "typebox";
import { Value } from "typebox/value";
import { createAgentBrowserRenderer } from "./extensions/agent-browser/renderer.ts";
import {
    createChromeDevtoolsMcpRenderer,
    createMcpGatewayRenderer,
    hasChromeDevtoolsName,
} from "./extensions/mcp-gateway/renderer.ts";
import { createPiCoreRenderer, isPiCoreTool } from "./extensions/pi/core-renderer.ts";
import { createGenericRenderer } from "./call-rendering.ts";
import { glowupRenderingAdapter, createProtocolRenderer } from "./protocol-renderer.ts";
import { baseToolName } from "./tool-values.ts";
import { GLOWUP_RENDERING_PROPERTY } from "../tool-rendering/protocol.ts";
import type {
    ThirdPartyToolRenderer,
    ThirdPartyToolRendererPlugin,
    ThirdPartyToolRenderingOptions,
    ToolNameMatcher,
} from "./types.ts";

export { GLOWUP_RENDERING_PROPERTY } from "../tool-rendering/protocol.ts";
export type { GlowupRenderingPreference } from "../tool-rendering/protocol.ts";
export type {
    ThirdPartyToolRenderContext,
    ThirdPartyToolRenderer,
    ThirdPartyToolRendererPlugin,
    ThirdPartyToolRenderingOptions,
    ThirdPartyToolResult,
    ToolNameMatcher,
} from "./types.ts";

// Transitional compatibility renderers remain here until each owning package ships a protocol
// adapter. Tool-owned adapters take precedence, so families can migrate independently.
const toolDefinitionViewSchema = Type.Object(
    {
        label: Type.Optional(Type.String()),
        [GLOWUP_RENDERING_PROPERTY]: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: true },
);
type ToolDefinitionView = Static<typeof toolDefinitionViewSchema>;

const toolDefinitionViewParser = {
    parse(value: unknown): ToolDefinitionView | undefined {
        try {
            return Value.Parse(toolDefinitionViewSchema, value);
        } catch {
            return undefined;
        }
    },
};

const TRANSITIONAL_RENDERER_PLUGINS: ReadonlyArray<ThirdPartyToolRendererPlugin> = [
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
];

function rendererPlugins(
    options: ThirdPartyToolRenderingOptions | undefined,
): ReadonlyArray<ThirdPartyToolRendererPlugin> {
    return [...(options?.renderers ?? []), ...TRANSITIONAL_RENDERER_PLUGINS];
}

/** Returns whether Glowup has a renderer for a tool that has not migrated to an owner adapter. */
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
    return (
        toolDefinitionViewParser.parse(toolDefinition)?.[GLOWUP_RENDERING_PROPERTY] === "preserve"
    );
}

function toolDefinitionLabel(toolDefinition: unknown): string | undefined {
    const label = toolDefinitionViewParser.parse(toolDefinition)?.label;
    return label === undefined || label.length === 0 ? undefined : label;
}

/** Returns whether a tool definition carries a valid public Glowup adapter. */
export function hasGlowupRenderingAdapter(toolDefinition: unknown): boolean {
    return glowupRenderingAdapter(toolDefinition) !== undefined;
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

/** Returns whether Glowup should leave a tool's original renderer untouched. */
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

/** Creates the owner adapter, transitional renderer, or generic compatibility renderer. */
export function createThirdPartyToolRenderer(
    toolName: string,
    options?: ThirdPartyToolRenderingOptions,
    toolDefinition?: unknown,
): ThirdPartyToolRenderer {
    const plugin = rendererPlugins(options).find((candidate) => candidate.matches(toolName));
    const fallback =
        plugin?.createRenderer(toolName, options) ??
        createGenericRenderer(toolName, toolDefinitionLabel(toolDefinition), options?.labelMode);
    const adapter = glowupRenderingAdapter(toolDefinition);
    return adapter === undefined
        ? fallback
        : createProtocolRenderer(adapter, fallback, options?.labelMode, options?.mutationSettings);
}
