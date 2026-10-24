import Type, { type Static } from "typebox";
import { Compile } from "typebox/compile";
import { createAgentBrowserRenderer } from "./external/agent-browser.ts";
import { createCodemodeRenderer } from "./external/codemode.ts";
import {
    createChromeDevtoolsMcpRenderer,
    createDirectMcpRenderer,
    createMcpGatewayRenderer,
    hasChromeDevtoolsName,
    isDirectMcpTool,
} from "./external/mcp-gateway.ts";
import { createPiCoreRenderer, isPiCoreTool } from "./external/pi-tools.ts";
import { createGenericRenderer } from "./call-rendering.ts";
import { glowupRenderingAdapter, createProtocolRenderer } from "./protocol/renderer.ts";
import { baseToolName } from "./tool-values.ts";
import {
    contributedToolRenderer,
    selectedGlowupPresentation,
} from "../rendering/presentation-registry.ts";
import { createSchemaRenderer, outputSchemaParser } from "./schema-rendering.ts";
import { GLOWUP_RENDERING_PROPERTY } from "./protocol/contract.ts";
import type {
    ThirdPartyToolRenderer,
    ThirdPartyToolRendererPlugin,
    ThirdPartyToolRenderingOptions,
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

const toolDefinitionViewValidator = Compile(toolDefinitionViewSchema);

type ToolDefinitionView = {
    readonly metadata: Static<typeof toolDefinitionViewSchema> | undefined;
    readonly preserve: boolean;
    readonly adapter: ReturnType<typeof glowupRenderingAdapter>;
};

const toolDefinitionViewParser = {
    parse(value: unknown): ToolDefinitionView {
        const adapter = glowupRenderingAdapter(value);

        try {
            const definition = toolDefinitionViewValidator.Parse(value);
            return {
                metadata: definition,
                preserve: definition[GLOWUP_RENDERING_PROPERTY] === "preserve",
                adapter,
            };
        } catch {
            return { metadata: undefined, preserve: false, adapter };
        }
    },
};

const TRANSITIONAL_RENDERER_PLUGINS: ReadonlyArray<ThirdPartyToolRendererPlugin> = [
    {
        name: "codemode",
        matches: (toolName) => toolName === "codemode",
        createRenderer: (_toolName, options) =>
            createCodemodeRenderer(
                options?.labelMode,
                options?.codemodePreview,
                options?.streamCode,
            ),
    },
    {
        name: "agent-browser",
        matches: (toolName) => toolName === "agent_browser",
        createRenderer: (toolName, options) =>
            createAgentBrowserRenderer(toolName, options?.labelMode, options?.streamCode),
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
            createChromeDevtoolsMcpRenderer(toolName, options?.labelMode, options?.streamCode),
    },
    {
        name: "direct-mcp-tools",
        matches: isDirectMcpTool,
        createRenderer: (toolName, options) =>
            createDirectMcpRenderer(toolName, options?.labelMode),
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
    return (
        contributedToolRenderer(toolName) !== undefined ||
        rendererPlugins(options).some((candidate) => candidate.matches(toolName))
    );
}

function matcherMatches(toolName: string, matcher: ToolNameMatcher): boolean {
    if (matcher.kind === "predicate") return matcher.matches(toolName);

    const { pattern } = matcher;
    pattern.lastIndex = 0;
    const matchesToolName = pattern.test(toolName);
    pattern.lastIndex = 0;
    const matchesBaseName = pattern.test(baseToolName(toolName));
    pattern.lastIndex = 0;
    return matchesToolName || matchesBaseName;
}

function hasPreservePreference(toolDefinition: unknown): boolean {
    return toolDefinitionViewParser.parse(toolDefinition).preserve;
}

function toolDefinitionLabel(definition: ToolDefinitionView): string | undefined {
    const label = definition.metadata?.label;
    return label === undefined || label.length === 0 ? undefined : label;
}

/** Returns whether a tool definition carries a valid public Glowup adapter. */
export function hasGlowupRenderingAdapter(toolDefinition: unknown): boolean {
    return toolDefinitionViewParser.parse(toolDefinition).adapter !== undefined;
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
    if (
        preserveTools.some(
            (name) => name === options.toolName || name === baseToolName(options.toolName),
        )
    ) {
        return true;
    }

    return (options.renderingOptions?.preserveMatchers ?? []).some((matcher) =>
        matcherMatches(options.toolName, matcher),
    );
}

/** Creates the owner adapter, transitional renderer, or generic compatibility renderer. */
export function createThirdPartyToolRenderer(
    toolName: string,
    options?: ThirdPartyToolRenderingOptions,
    toolDefinition?: unknown,
): ThirdPartyToolRenderer {
    const definition = toolDefinitionViewParser.parse(toolDefinition);
    const plugin = rendererPlugins(options).find((candidate) => candidate.matches(toolName));
    const generic = createGenericRenderer(
        toolName,
        toolDefinitionLabel(definition),
        options?.labelMode,
    );
    if (definition.preserve || options?.enabled === false) return generic;

    const fallback = selectedGlowupPresentation().createRenderer(
        toolName,
        plugin?.createRenderer(toolName, options) ?? generic,
        options,
    );
    if (definition.adapter !== undefined)
        return createProtocolRenderer(
            definition.adapter,
            fallback,
            options?.labelMode,
            options?.mutationSettings,
            options?.streamCode,
        );

    const contributed = contributedToolRenderer(toolName);
    if (contributed !== undefined) return contributed.create(fallback, options);

    const outputSchema = outputSchemaParser.parse(definition.metadata);
    if (outputSchema !== undefined) return createSchemaRenderer(outputSchema, fallback, options);

    return fallback;
}
