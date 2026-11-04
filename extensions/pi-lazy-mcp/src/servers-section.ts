import { configuredExposures, isEnabled, mcpNamespace, type McpServerEntry } from "./config.ts";

export const MCP_SERVERS_SECTION = "mcp_servers";
const MAX_SERVER_DESCRIPTION_CHARS = 250;
const MAX_SERVERS_SECTION_CHARS = 4096;

export type ListedServer = {
    entry: McpServerEntry;
    instructions: string | undefined;
};

function hasIndirectTools(entry: McpServerEntry): boolean {
    const exposures = configuredExposures(entry.config);
    return exposures.has("codemode") || exposures.has("deferred");
}

function reachOf(entry: McpServerEntry): "codemode" | "tool_search" {
    if (configuredExposures(entry.config).has("codemode")) return "codemode";

    return "tool_search";
}

function intro(reaches: ReadonlySet<string>): string {
    let text = "MCP servers whose tools are not declared to you.";
    if (reaches.has("codemode"))
        text += " Call the tools of `codemode` servers from codemode scripts.";

    if (reaches.has("tool_search"))
        text += " Load the tools of `tool_search` servers with `tool_search`.";

    return text;
}

function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    if (max <= 1) return "";

    return `${text.slice(0, max - 1).trimEnd()}…`;
}

function summaryOf(server: ListedServer): string {
    const description = server.entry.config.description?.trim();
    let text = server.instructions ?? "";
    if (description !== undefined && description !== "") text = description;

    return (text.split("\n", 1)[0] ?? "").trim();
}

function omittedLines(count: number): string[] {
    if (count <= 0) return [];

    let noun = "servers";
    if (count === 1) noun = "server";

    return [`- … ${count} more ${noun}; find their tools with searchTools()`];
}

export function renderServersSection(servers: readonly ListedServer[]): string | undefined {
    const listed = servers
        .filter((server) => isEnabled(server.entry.config) && hasIndirectTools(server.entry))
        .sort((a, b) => a.entry.name.localeCompare(b.entry.name));
    if (listed.length === 0) return undefined;

    const reaches = listed.map((server) => reachOf(server.entry));
    const heading = intro(new Set(reaches));
    const heads = listed.map(
        (server, index) => `- ${mcpNamespace(server.entry.name)} (${reaches[index]})`,
    );
    const size = (kept: number): number =>
        [heading, ...heads.slice(0, kept), ...omittedLines(listed.length - kept)].join("\n").length;

    let kept = listed.length;
    while (kept > 0 && size(kept) > MAX_SERVERS_SECTION_CHARS) kept -= 1;

    let perServer = 0;
    if (kept > 0)
        perServer = Math.min(
            MAX_SERVER_DESCRIPTION_CHARS,
            Math.floor((MAX_SERVERS_SECTION_CHARS - size(kept)) / kept) - 2,
        );

    const lines = listed.slice(0, kept).map((server, index) => {
        let summary = "";
        if (perServer > 0) summary = truncate(summaryOf(server), perServer);

        if (summary === "") return heads[index] ?? "";

        return `${heads[index]}: ${summary}`;
    });

    return [heading, ...lines, ...omittedLines(listed.length - kept)].join("\n");
}
