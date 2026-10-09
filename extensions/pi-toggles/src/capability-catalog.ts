import type { Skill, SlashCommandInfo, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
    createCapabilityId,
    normalizeSourceInfo,
    type Capability,
    type CapabilitySource,
} from "./capability.ts";
import type { ScopedPromptFragment } from "./capability-policy.ts";

export const TOGGLES_COMMAND_NAME = "toggles";
export const LAZY_SEARCH_TOOL_NAME = "search_capabilities";

export type CapabilityCatalogInput = {
    readonly tools: readonly ToolInfo[];
    readonly activeToolNames: ReadonlySet<string>;
    readonly commands: readonly SlashCommandInfo[];
    readonly skills?: readonly Skill[];
    readonly promptFragments: readonly ScopedPromptFragment[];
};

function toolSearchText(tool: ToolInfo): string {
    let parameters = "";
    try {
        parameters = JSON.stringify(tool.parameters);
    } catch {
        parameters = "";
    }
    return [tool.name, tool.description, parameters, ...(tool.promptGuidelines ?? [])]
        .join(" ")
        .slice(0, 10_000);
}

function toolCapability(tool: ToolInfo, activeToolNames: ReadonlySet<string>): Capability {
    const source = normalizeSourceInfo(tool.sourceInfo);
    const declared = activeToolNames.has(tool.name);
    return {
        id: createCapabilityId("tool", tool.name, source),
        kind: "tool",
        name: tool.name,
        description: tool.description,
        searchText: toolSearchText(tool),
        source,
        observedState:
            tool.exposure === "hidden"
                ? "unavailable"
                : declared || tool.exposure === "codemode" || tool.exposure === "deferred"
                  ? "active"
                  : "inactive",
        exposure: tool.exposure,
        declared,
        supported: tool.exposure !== "hidden",
        protected: tool.name === LAZY_SEARCH_TOOL_NAME,
    };
}

function extensionCommandCapability(command: SlashCommandInfo): Capability {
    const source = normalizeSourceInfo(command.sourceInfo);
    return {
        id: createCapabilityId("command", command.name, source),
        kind: "command",
        name: command.name,
        ...(command.description === undefined ? {} : { description: command.description }),
        source,
        observedState: "active",
        supported: false,
        protected: command.name === TOGGLES_COMMAND_NAME,
    };
}

function skillCapability(skill: Skill): Capability {
    const source = normalizeSourceInfo(skill.sourceInfo);
    return {
        id: createCapabilityId("skill", skill.name, source),
        kind: "skill",
        name: skill.name,
        description: skill.description,
        source,
        observedState: skill.disableModelInvocation ? "inactive" : "active",
        supported: true,
        protected: false,
    };
}

function skillCommandCapability(command: SlashCommandInfo): Capability {
    const source = normalizeSourceInfo(command.sourceInfo);
    const name = command.name.replace(/^skill:/, "");
    return {
        id: createCapabilityId("skill", name, source),
        kind: "skill",
        name,
        ...(command.description === undefined ? {} : { description: command.description }),
        source,
        observedState: "active",
        supported: true,
        protected: false,
    };
}

function fragmentCapability(scoped: ScopedPromptFragment): Capability {
    const { fragment } = scoped;
    const source: CapabilitySource = {
        source: "pi-toggles",
        scope: scoped.scope === "project" ? "project" : "user",
        origin: "top-level",
        path:
            fragment.content.kind === "file"
                ? fragment.content.path
                : `<pi-toggles:fragment:${fragment.id}>`,
    };
    return {
        id: createCapabilityId("system-fragment", fragment.id, source),
        kind: "system-fragment",
        name: fragment.id,
        description: "Pi-Toggles-owned conditional system-prompt fragment",
        source,
        observedState: "inactive",
        supported: true,
        protected: false,
    };
}

export function buildCapabilityCatalog(input: CapabilityCatalogInput): readonly Capability[] {
    const commands = input.commands
        .filter((command) => command.source === "extension")
        .map(extensionCommandCapability);
    const skills =
        input.skills === undefined
            ? input.commands
                  .filter((command) => command.source === "skill")
                  .map(skillCommandCapability)
            : input.skills.map(skillCapability);
    const capabilities = [
        ...input.tools.map((tool) => toolCapability(tool, input.activeToolNames)),
        ...commands,
        ...skills,
        ...input.promptFragments.map(fragmentCapability),
    ];
    return capabilities.sort((left, right) =>
        `${left.kind}:${left.name}:${left.source.source}`.localeCompare(
            `${right.kind}:${right.name}:${right.source.source}`,
        ),
    );
}
