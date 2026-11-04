import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveConfigValue } from "../src/config-value.ts";
import { loadMcpConfig, toolExposureOf, validateServerConfig } from "../src/config.ts";
import type { JsonObject } from "../src/json.ts";

const directories: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();

    for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});

type Files = {
    global?: JsonObject;
    rawGlobal?: string;
    project?: JsonObject;
    projectTrusted?: boolean;
};

async function load({ global, rawGlobal, project, projectTrusted = true }: Files) {
    const root = await mkdtemp(join(tmpdir(), "pi-lazy-mcp-config-"));
    directories.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await mkdir(agentDir);
    await mkdir(join(cwd, ".pi"), { recursive: true });

    if (rawGlobal !== undefined) await writeFile(join(agentDir, "mcp.json"), rawGlobal);
    if (global !== undefined) await writeFile(join(agentDir, "mcp.json"), JSON.stringify(global));

    if (project !== undefined)
        await writeFile(join(cwd, ".pi", "mcp.json"), JSON.stringify(project));

    const loaded = loadMcpConfig({ agentDir, cwd, projectTrusted });

    return {
        ...loaded,
        server: (name: string) => loaded.servers.find((entry) => entry.name === name),
    };
}

describe("mcp.json loading", () => {
    it("has no servers and no errors when neither file exists", async () => {
        const loaded = await load({});
        expect(loaded.servers).toEqual([]);
        expect(loaded.errors).toEqual([]);
    });

    it("reports invalid JSON with its path and still loads the other file", async () => {
        const loaded = await load({
            rawGlobal: "{ broken",
            project: { mcpServers: { sample: { command: "tool" } } },
        });
        expect(loaded.errors).toHaveLength(1);
        expect(loaded.errors[0]).toContain(join("agent", "mcp.json"));
        expect(loaded.server("sample")?.config).toMatchObject({ command: "tool" });
    });

    it.each(["[]", '{"mcpServers":[]}', '{"mcpServers":"none"}'])(
        "reports a wrong top-level shape: %s",
        async (rawGlobal) => {
            const loaded = await load({ rawGlobal });
            expect(loaded.errors[0]).toContain('expected an object with an "mcpServers" object');
            expect(loaded.servers).toEqual([]);
        },
    );

    it("accepts a byte order mark", async () => {
        const loaded = await load({
            rawGlobal: `\uFEFF${JSON.stringify({ mcpServers: { sample: { command: "tool" } } })}`,
        });
        expect(loaded.errors).toEqual([]);
        expect(loaded.server("sample")).toBeDefined();
    });

    it("ignores the project file until the project is trusted", async () => {
        const files = {
            global: { mcpServers: { shared: { command: "global-tool" } } },
            project: {
                autoEnableCodemode: false,
                mcpServers: { shared: { enabled: false }, local: { command: "local-tool" } },
            },
        };
        const untrusted = await load({ ...files, projectTrusted: false });
        expect(untrusted.server("local")).toBeUndefined();
        expect(untrusted.server("shared")?.config.enabled).toBeUndefined();
        expect(untrusted.autoEnableCodemode).toBeUndefined();

        const trusted = await load({ ...files, projectTrusted: true });
        expect(trusted.server("local")).toBeDefined();
        expect(trusted.server("shared")?.config.enabled).toBe(false);
        expect(trusted.autoEnableCodemode).toBe(false);
    });

    it("lets a project definition replace the global entry entirely", async () => {
        const loaded = await load({
            global: {
                mcpServers: {
                    shared: { command: "global-tool", env: { TOKEN: "${SAMPLE}" }, timeout: 5 },
                },
            },
            project: {
                mcpServers: { shared: { command: "node", args: ["local.js", "mcp"] } },
            },
        });
        expect(loaded.server("shared")?.config).toEqual({
            command: "node",
            args: ["local.js", "mcp"],
        });

        expect(loaded.server("shared")?.scope).toBe("project");
    });

    it("lets a project switch transport by defining the server with a url", async () => {
        const loaded = await load({
            global: { mcpServers: { shared: { command: "global-tool" } } },
            project: {
                mcpServers: {
                    shared: { url: "http://127.0.0.1:1/mcp", description: "Local endpoint" },
                },
            },
        });
        expect(loaded.server("shared")?.config).toEqual({
            url: "http://127.0.0.1:1/mcp",
            description: "Local endpoint",
        });
    });

    it("keeps the global env and headers under a project override", async () => {
        const loaded = await load({
            global: {
                mcpServers: {
                    stdio: { command: "tool", env: { TOKEN: "${SAMPLE}" } },
                    http: {
                        url: "http://127.0.0.1:1/mcp",
                        headers: { Authorization: "${SAMPLE}" },
                    },
                },
            },
            project: {
                mcpServers: {
                    stdio: { exposure: "direct" },
                    http: { toolExposure: { "get_*": "hidden" } },
                },
            },
        });
        expect(loaded.server("stdio")?.config).toEqual({
            command: "tool",
            env: { TOKEN: "${SAMPLE}" },
            exposure: "direct",
        });

        expect(loaded.server("http")?.config).toMatchObject({
            headers: { Authorization: "${SAMPLE}" },
            toolExposure: { "get_*": "hidden" },
        });

        expect(loaded.server("stdio")?.scope).toBe("global");
        expect(loaded.server("stdio")?.override).toContain(join(".pi", "mcp.json"));
    });

    it("reports an override that sets other keys and keeps the global entry", async () => {
        const loaded = await load({
            global: { mcpServers: { shared: { command: "tool" } } },
            project: { mcpServers: { shared: { env: { TOKEN: "x" } } } },
        });
        expect(loaded.errors[0]).toContain("an override can only set");
        expect(loaded.server("shared")?.config).toEqual({ command: "tool" });
    });

    it("reports an override of a server no global file defines", async () => {
        const loaded = await load({ project: { mcpServers: { missing: { enabled: false } } } });
        expect(loaded.errors[0]).toContain('server "missing" needs "command" or "url"');
        expect(loaded.server("missing")).toBeUndefined();
    });

    it("does not treat a global entry without a transport as an override", async () => {
        const loaded = await load({ global: { mcpServers: { lone: { enabled: false } } } });
        expect(loaded.errors[0]).toContain('needs either "command"');
    });

    it("skips invalid entries and keeps their neighbours", async () => {
        const loaded = await load({
            global: {
                mcpServers: {
                    "bad name": { command: "tool" },
                    timeout: { command: "tool", timeout: 0 },
                    exposure: { command: "tool", exposure: "everywhere" },
                    args: { command: "tool", args: "serve" },
                    env: { command: "tool", env: { TOKEN: 1 } },
                    sse: { type: "sse", url: "http://127.0.0.1:1/sse" },
                    ftp: { url: "ftp://127.0.0.1/mcp" },
                    credentials: { url: "http://user:hidden@127.0.0.1/mcp" },
                    good: { command: "tool" },
                },
            },
        });
        expect(loaded.servers.map((entry) => entry.name)).toEqual(["good"]);
        expect(loaded.errors).toHaveLength(8);
        expect(loaded.errors.join("\n")).toContain("legacy SSE transport");
        expect(loaded.errors.join("\n")).toContain('server "timeout": /timeout');
        expect(loaded.errors.join("\n")).not.toContain("hidden");
    });

    it("rejects a name differing only in - and _ because tool names would collide", async () => {
        const loaded = await load({
            global: {
                mcpServers: { "sample-one": { command: "a" }, sample_one: { command: "b" } },
            },
        });
        expect(loaded.errors[0]).toContain('"sample_one" conflicts with "sample-one"');
        expect(loaded.servers.map((entry) => entry.name)).toEqual(["sample-one"]);
    });

    it("keeps disabled servers so status can list them", async () => {
        const loaded = await load({
            global: { mcpServers: { off: { command: "tool", enabled: false } } },
        });
        expect(loaded.server("off")?.config.enabled).toBe(false);
    });

    it("prefers the project's autoEnableCodemode and reports a non-boolean", async () => {
        const overridden = await load({
            global: { autoEnableCodemode: false },
            project: { autoEnableCodemode: true },
        });
        expect(overridden.autoEnableCodemode).toBe(true);

        const invalid = await load({ global: { autoEnableCodemode: "no" } });
        expect(invalid.errors[0]).toContain("autoEnableCodemode must be a boolean");
        expect(invalid.autoEnableCodemode).toBeUndefined();
    });
});

describe("server entry validation", () => {
    it("resolves the codemode-deferred alias for the server and its tools", () => {
        const config = validateServerConfig("sample", {
            command: "tool",
            exposure: "codemode-deferred",
            toolExposure: { lookup: "codemode-deferred" },
        });
        expect(config).toMatchObject({
            exposure: "codemode",
            toolExposure: { lookup: "codemode" },
        });
    });

    it("accepts streamable-http and auth settings so the caller can refuse them per server", () => {
        const config = validateServerConfig("sample", {
            type: "streamable-http",
            url: "https://example.invalid/mcp",
            oauth: { clientId: "sample" },
        });
        expect(config).toMatchObject({ type: "streamable-http", oauth: { clientId: "sample" } });
    });
});

describe("tool exposure", () => {
    const config = {
        command: "tool",
        exposure: "deferred",
        toolExposure: {
            "get_*": "hidden",
            "get_public_*": "direct",
            get_exact: "codemode",
        },
    } as const;

    it("prefers exact names, then the first matching pattern, then the server", () => {
        expect(toolExposureOf(config, "get_exact")).toBe("codemode");
        expect(toolExposureOf(config, "get_public_item")).toBe("hidden");
        expect(toolExposureOf(config, "other")).toBe("deferred");
    });

    it("defaults to codemode", () => {
        expect(toolExposureOf({ command: "tool" }, "other")).toBe("codemode");
    });

    it("treats pattern metacharacters literally", () => {
        const dotted = { command: "tool", toolExposure: { "a.b*": "hidden" } } as const;
        expect(toolExposureOf(dotted, "a.bc")).toBe("hidden");
        expect(toolExposureOf(dotted, "axbc")).toBe("codemode");
    });
});

describe("config value expansion", () => {
    it.each([
        ["Bearer ${SAMPLE_TOKEN}", "Bearer sample-value"],
        ["$SAMPLE_TOKEN/suffix", "sample-value/suffix"],
        ["a${SAMPLE_TOKEN}b$SAMPLE_TOKEN", "asample-valuebsample-value"],
        ["no variables", "no variables"],
        ["cost: $$5", "cost: $5"],
        ["$!literal", "!literal"],
        ["trailing $", "trailing $"],
        ["${not-a-name}", "${not-a-name}"],
        ["${unterminated", "${unterminated"],
        ["mid!dle", "mid!dle"],
    ])("expands %s", (value, expected) => {
        vi.stubEnv("SAMPLE_TOKEN", "sample-value");
        expect(resolveConfigValue(value, "value")).toBe(expected);
    });

    it("names a missing variable", () => {
        vi.stubEnv("SAMPLE_MISSING", undefined);
        expect(() => resolveConfigValue("Bearer ${SAMPLE_MISSING}", 'env "TOKEN"')).toThrow(
            'Failed to resolve env "TOKEN" from environment variable: SAMPLE_MISSING',
        );
    });

    it("treats an empty variable as missing", () => {
        vi.stubEnv("SAMPLE_EMPTY", "");
        expect(() => resolveConfigValue("$SAMPLE_EMPTY", "value")).toThrow("SAMPLE_EMPTY");
    });

    it("names every missing variable without revealing the ones it found", () => {
        vi.stubEnv("SAMPLE_PRESENT", "sample-value");
        vi.stubEnv("SAMPLE_A", undefined);
        vi.stubEnv("SAMPLE_B", undefined);
        const resolve = () => resolveConfigValue("$SAMPLE_PRESENT$SAMPLE_A:$SAMPLE_B", "value");
        expect(resolve).toThrow("environment variables: SAMPLE_A, SAMPLE_B");
        expect(resolve).not.toThrow("sample-value");
    });

    it("uses the trimmed output of a whole-value command", () => {
        expect(resolveConfigValue("!printf ' from-command\\n'", "value")).toBe("from-command");
    });

    it("sees the environment inside a command", () => {
        vi.stubEnv("SAMPLE_TOKEN", "sample-value");
        expect(resolveConfigValue('!printf "%s" "$SAMPLE_TOKEN"', "value")).toBe("sample-value");
    });

    it.each(["!exit 3", "!true"])("fails %s without echoing the command", (value) => {
        const resolve = () => resolveConfigValue(value, 'header "Authorization"');
        expect(resolve).toThrow('Failed to resolve header "Authorization" from its shell command');
        expect(resolve).not.toThrow(value.slice(1));
    });
});
