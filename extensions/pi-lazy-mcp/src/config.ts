import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import {
    isJsonObject,
    isJsonString,
    jsonValueSchema,
    type JsonObject,
    type JsonValue,
} from "./json.ts";

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];
const EXPOSURE_ALIASES = new Map([["codemode-deferred", "codemode"]]);
const exposureSchema = Type.Enum(["codemode", "deferred", "direct", "hidden"]);
const commonFields = {
    enabled: Type.Optional(Type.Boolean()),
    exposure: Type.Optional(exposureSchema),
    toolExposure: Type.Optional(Type.Record(Type.String(), exposureSchema)),
    timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    description: Type.Optional(Type.String()),
};
const stringRecord = Type.Record(Type.String(), Type.String());

const stdioConfigSchema = Type.Object({
    ...commonFields,
    type: Type.Optional(Type.Literal("stdio")),
    command: Type.String(),
    args: Type.Optional(Type.Array(Type.String())),
    env: Type.Optional(stringRecord),
    cwd: Type.Optional(Type.String()),
});

const httpConfigSchema = Type.Object({
    ...commonFields,
    type: Type.Optional(Type.Enum(["http", "streamable-http"])),
    url: Type.String(),
    headers: Type.Optional(stringRecord),
    auth: Type.Optional(jsonValueSchema),
    oauth: Type.Optional(jsonValueSchema),
});

const overrideSchema = Type.Object(
    {
        enabled: commonFields.enabled,
        exposure: commonFields.exposure,
        toolExposure: commonFields.toolExposure,
    },
    { additionalProperties: false },
);

const configFileSchema = Type.Object({
    autoEnableCodemode: Type.Optional(jsonValueSchema),
    mcpServers: Type.Optional(Type.Record(Type.String(), jsonValueSchema)),
});

export type McpExposure = Static<typeof exposureSchema>;
export type StdioServerConfig = Static<typeof stdioConfigSchema>;
export type HttpServerConfig = Static<typeof httpConfigSchema>;
export type McpServerConfig = StdioServerConfig | HttpServerConfig;

export type McpServerEntry = {
    name: string;
    config: McpServerConfig;
    source: string;
    scope: "global" | "project";
    override?: string;
};

export type LoadedMcpConfig = {
    servers: McpServerEntry[];
    autoEnableCodemode?: boolean;
    errors: string[];
};

type LoadState = {
    servers: Map<string, McpServerEntry>;
    autoEnableCodemode?: boolean;
    errors: string[];
};

function errorMessage(cause: unknown): string {
    if (cause instanceof Error) return cause.message;

    return String(cause);
}

export function mcpNamespace(server: string): string {
    return `mcp__${server.replace(/-/g, "_")}`;
}

function toolPattern(pattern: string): RegExp {
    const source = pattern
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
    return new RegExp(`^${source}$`);
}

export function exposureOf(config: McpServerConfig): McpExposure {
    return config.exposure ?? "codemode";
}

export function toolExposureOf(config: McpServerConfig, toolName: string): McpExposure {
    const overrides = config.toolExposure ?? {};
    const exact = overrides[toolName];
    if (exact !== undefined) return exact;

    for (const [pattern, exposure] of Object.entries(overrides)) {
        if (pattern.includes("*") && toolPattern(pattern).test(toolName)) return exposure;
    }

    return exposureOf(config);
}

export function configuredExposures(config: McpServerConfig): Set<McpExposure> {
    return new Set([exposureOf(config), ...Object.values(config.toolExposure ?? {})]);
}

export function isEnabled(config: McpServerConfig): boolean {
    return config.enabled !== false;
}

export function usesAuthentication(config: McpServerConfig): boolean {
    return "url" in config && (config.auth !== undefined || config.oauth !== undefined);
}

function resolveAlias(value: JsonValue): JsonValue {
    if (!isJsonString(value)) return value;

    return EXPOSURE_ALIASES.get(value) ?? value;
}

function resolveExposureAliases(value: JsonObject) {
    const resolved = { ...value };
    if (value.exposure !== undefined) resolved.exposure = resolveAlias(value.exposure);

    const toolExposure = value.toolExposure;
    if (toolExposure !== undefined && isJsonObject(toolExposure)) {
        resolved.toolExposure = Object.fromEntries(
            Object.entries(toolExposure).map(([tool, exposure]) => [tool, resolveAlias(exposure)]),
        );
    }

    return resolved;
}

function firstSchemaError(name: string, schema: TSchema, value: JsonObject): string {
    const error = Value.Errors(schema, value).at(0);
    if (error === undefined) return `server "${name}" is invalid`;

    return `server "${name}": ${error.instancePath} ${error.message}`;
}

function urlProblem(url: string): string | undefined {
    if (!URL.canParse(url)) return "url must be an http or https URL";

    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        return "url must be an http or https URL";

    if (parsed.username !== "" || parsed.password !== "")
        return "url must not embed credentials; use headers";

    return undefined;
}

export function validateServerConfig(name: string, raw: JsonValue): McpServerConfig | string {
    if (!SERVER_NAME.test(name))
        return `invalid server name "${name}" (use letters, digits, "_" and "-")`;

    if (!isJsonObject(raw)) return `server "${name}" must be an object`;

    const value = resolveExposureAliases(raw);
    const { type, url, command } = value;
    if (type === "sse")
        return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`;

    if (
        url !== undefined &&
        isJsonString(url) &&
        (type === undefined || type === "http" || type === "streamable-http")
    ) {
        if (!Value.Check(httpConfigSchema, value))
            return firstSchemaError(name, httpConfigSchema, value);

        const problem = urlProblem(url);
        if (problem !== undefined) return `server "${name}": ${problem}`;

        return value;
    }

    if (
        command !== undefined &&
        isJsonString(command) &&
        (type === undefined || type === "stdio")
    ) {
        if (!Value.Check(stdioConfigSchema, value))
            return firstSchemaError(name, stdioConfigSchema, value);

        return value;
    }

    return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
}

function isOverride(value: JsonObject): boolean {
    return value.command === undefined && value.url === undefined && value.type === undefined;
}

function applyOverride(path: string, name: string, raw: JsonObject, state: LoadState): void {
    const base = state.servers.get(name);
    if (base === undefined) {
        state.errors.push(
            `${path}: server "${name}" needs "command" or "url", or a global server to override`,
        );

        return;
    }

    if (Object.keys(raw).some((key) => !OVERRIDE_KEYS.includes(key))) {
        state.errors.push(
            `${path}: server "${name}": an override can only set ${OVERRIDE_KEYS.join(", ")}`,
        );

        return;
    }

    const value = resolveExposureAliases(raw);
    if (!Value.Check(overrideSchema, value)) {
        state.errors.push(`${path}: ${firstSchemaError(name, overrideSchema, value)}`);
        return;
    }

    state.servers.set(name, {
        ...base,
        config: { ...base.config, ...value },
        override: path,
    });
}

function readConfigFile(path: string, scope: McpServerEntry["scope"], state: LoadState): void {
    if (!existsSync(path)) return;

    let parsed: JsonValue;
    try {
        parsed = Value.Parse(
            jsonValueSchema,
            JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")),
        );
    } catch (cause) {
        state.errors.push(`${path}: ${errorMessage(cause)}`);
        return;
    }

    if (!Value.Check(configFileSchema, parsed)) {
        state.errors.push(`${path}: expected an object with an "mcpServers" object`);
        return;
    }

    const autoEnableCodemode = parsed.autoEnableCodemode;
    if (autoEnableCodemode === true || autoEnableCodemode === false)
        state.autoEnableCodemode = autoEnableCodemode;
    else if (autoEnableCodemode !== undefined)
        state.errors.push(`${path}: autoEnableCodemode must be a boolean`);

    for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
        if (scope === "project" && isJsonObject(value) && isOverride(value)) {
            applyOverride(path, name, value, state);
            continue;
        }

        const config = validateServerConfig(name, value);
        if (isJsonString(config)) {
            state.errors.push(`${path}: ${config}`);
            continue;
        }

        const clash = [...state.servers.keys()].find(
            (other) => other !== name && mcpNamespace(other) === mcpNamespace(name),
        );
        if (clash !== undefined) {
            state.errors.push(`${path}: server "${name}" conflicts with "${clash}"`);
            continue;
        }

        state.servers.set(name, { name, config, source: path, scope });
    }
}

export function loadMcpConfig(options: {
    agentDir: string;
    cwd: string;
    projectTrusted: boolean;
}): LoadedMcpConfig {
    const state: LoadState = { servers: new Map(), errors: [] };
    readConfigFile(join(options.agentDir, "mcp.json"), "global", state);

    if (options.projectTrusted)
        readConfigFile(join(options.cwd, CONFIG_DIR_NAME, "mcp.json"), "project", state);

    const loaded: LoadedMcpConfig = { servers: [...state.servers.values()], errors: state.errors };
    if (state.autoEnableCodemode !== undefined)
        loaded.autoEnableCodemode = state.autoEnableCodemode;

    return loaded;
}
