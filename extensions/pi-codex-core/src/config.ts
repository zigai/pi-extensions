import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { compileSchema, parseWithSchema } from "./schema-parsing.ts";

export type CodexPromptMode = "pi" | "codex";
export type CodexToolScope = "codex" | "all";
export type CodexVerbosity = "low" | "medium" | "high";
export type CodexCompactionReasoning = "current" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Config value that means Codex API requests should use the active Codex model. */
export const CODEX_CURRENT_MODEL_SELECTION = "current";
export const CODEX_TOOL_SCOPES: readonly CodexToolScope[] = ["codex", "all"];
export const CODEX_PROMPT_MODES: readonly CodexPromptMode[] = ["pi", "codex"];
export const CODEX_VERBOSITY_LEVELS: readonly CodexVerbosity[] = ["low", "medium", "high"];
export const CODEX_COMPACTION_REASONING_LEVELS: readonly CodexCompactionReasoning[] = [
    "current",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
];

export type CodexCoreConfig = {
    readonly scope: {
        readonly tools: CodexToolScope;
    };
    readonly tools: {
        readonly webSearch: boolean;
        readonly imageGeneration: boolean;
        readonly viewImage: boolean;
        readonly viewImageDescriptions: boolean;
    };
    readonly prompt: {
        readonly mode: CodexPromptMode;
    };
    readonly compaction: {
        readonly enabled: boolean;
        readonly auto: boolean;
        readonly thresholdPercent: number;
    };
    readonly openai: {
        readonly webSearchModel: string;
        readonly imageModel: string;
        readonly imageDescriptionModel: string;
        readonly compactionModel: string;
        readonly compactionReasoning: CodexCompactionReasoning;
        readonly verbosity: CodexVerbosity;
        readonly fast: boolean;
    };
};

export const CODEX_CORE_CONFIG_BASENAME = "pi-codex-core.json";

const UnknownRecordSchema = compileSchema(Type.Record(Type.String(), Type.Unknown()));
const BooleanSchema = compileSchema(Type.Boolean());
const NumberSchema = compileSchema(Type.Number());
const StringSchema = compileSchema(Type.String());

export const DEFAULT_CODEX_CORE_CONFIG: CodexCoreConfig = {
    scope: { tools: "codex" },
    tools: {
        webSearch: true,
        imageGeneration: true,
        viewImage: true,
        viewImageDescriptions: false,
    },
    prompt: { mode: "pi" },
    compaction: { enabled: false, auto: true, thresholdPercent: 80 },
    openai: {
        webSearchModel: CODEX_CURRENT_MODEL_SELECTION,
        imageModel: "gpt-image-2",
        imageDescriptionModel: CODEX_CURRENT_MODEL_SELECTION,
        compactionModel: CODEX_CURRENT_MODEL_SELECTION,
        compactionReasoning: "medium",
        verbosity: "low",
        fast: false,
    },
};

export function getCodexCoreConfigPath(agentDir: string = getAgentDir()): string {
    return join(agentDir, CODEX_CORE_CONFIG_BASENAME);
}

export function parseCodexCoreConfig(value: unknown): CodexCoreConfig {
    const root = parseRecord(value);

    const scope = parseRecord(root.scope);
    const tools = parseRecord(root.tools);
    const prompt = parseRecord(root.prompt);
    const compaction = parseRecord(root.compaction);
    const openai = parseRecord(root.openai);

    return {
        scope: {
            tools:
                parseStringEnum(scope.tools, CODEX_TOOL_SCOPES) ??
                DEFAULT_CODEX_CORE_CONFIG.scope.tools,
        },
        tools: {
            webSearch: parseBoolean(tools.webSearch, DEFAULT_CODEX_CORE_CONFIG.tools.webSearch),
            imageGeneration: parseBoolean(
                tools.imageGeneration,
                DEFAULT_CODEX_CORE_CONFIG.tools.imageGeneration,
            ),
            viewImage: parseBoolean(tools.viewImage, DEFAULT_CODEX_CORE_CONFIG.tools.viewImage),
            viewImageDescriptions: parseBoolean(
                tools.viewImageDescriptions,
                DEFAULT_CODEX_CORE_CONFIG.tools.viewImageDescriptions,
            ),
        },
        prompt: {
            mode:
                parseStringEnum(prompt.mode, CODEX_PROMPT_MODES) ??
                DEFAULT_CODEX_CORE_CONFIG.prompt.mode,
        },
        compaction: {
            enabled: parseBoolean(compaction.enabled, DEFAULT_CODEX_CORE_CONFIG.compaction.enabled),
            auto: parseBoolean(compaction.auto, DEFAULT_CODEX_CORE_CONFIG.compaction.auto),
            thresholdPercent: parsePercent(
                compaction.thresholdPercent,
                DEFAULT_CODEX_CORE_CONFIG.compaction.thresholdPercent,
            ),
        },
        openai: {
            webSearchModel: parseNonEmptyString(
                openai.webSearchModel,
                DEFAULT_CODEX_CORE_CONFIG.openai.webSearchModel,
            ),
            imageModel: parseNonEmptyString(
                openai.imageModel,
                DEFAULT_CODEX_CORE_CONFIG.openai.imageModel,
            ),
            imageDescriptionModel: parseNonEmptyString(
                openai.imageDescriptionModel,
                DEFAULT_CODEX_CORE_CONFIG.openai.imageDescriptionModel,
            ),
            compactionModel: parseNonEmptyString(
                openai.compactionModel,
                DEFAULT_CODEX_CORE_CONFIG.openai.compactionModel,
            ),
            compactionReasoning:
                parseStringEnum(openai.compactionReasoning, CODEX_COMPACTION_REASONING_LEVELS) ??
                DEFAULT_CODEX_CORE_CONFIG.openai.compactionReasoning,
            verbosity:
                parseStringEnum(openai.verbosity, CODEX_VERBOSITY_LEVELS) ??
                DEFAULT_CODEX_CORE_CONFIG.openai.verbosity,
            fast: parseBoolean(openai.fast, DEFAULT_CODEX_CORE_CONFIG.openai.fast),
        },
    };
}

export function readCodexCoreConfig(
    configPath: string = getCodexCoreConfigPath(),
): CodexCoreConfig {
    if (!existsSync(configPath)) {
        writeCodexCoreConfig(DEFAULT_CODEX_CORE_CONFIG, configPath);
        return structuredClone(DEFAULT_CODEX_CORE_CONFIG);
    }

    try {
        const rawConfig: unknown = JSON.parse(readFileSync(configPath, "utf8"));
        return parseCodexCoreConfig(rawConfig);
    } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);
        console.warn(`[pi-codex-core] Failed to read ${configPath}: ${message}`);
        return structuredClone(DEFAULT_CODEX_CORE_CONFIG);
    }
}

/** Resolves `current` model selections to the active Codex request model. */
export function resolveCodexRequestModel(configuredModel: string, currentModel: string): string {
    const configured = configuredModel.trim();
    if (configured !== CODEX_CURRENT_MODEL_SELECTION) return configured;
    const activeModel = currentModel.trim();
    if (activeModel.length === 0)
        throw new Error("Codex current model selection requires an active Codex model.");
    return activeModel;
}

/** Formats model selections for user-facing Pi settings/status text. */
export function formatCodexModelSelection(configuredModel: string): string {
    const configured = configuredModel.trim();
    return configured === CODEX_CURRENT_MODEL_SELECTION ? "current model" : configured;
}

export function writeCodexCoreConfig(
    config: CodexCoreConfig,
    configPath: string = getCodexCoreConfigPath(),
): { readonly ok: true } | { readonly ok: false; readonly error: string } {
    try {
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(
            configPath,
            `${JSON.stringify(parseCodexCoreConfig(config), null, 2)}\n`,
            "utf8",
        );
        return { ok: true };
    } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);
        console.warn(`[pi-codex-core] Failed to write ${configPath}: ${message}`);
        return { ok: false, error: message };
    }
}

function parseRecord(value: unknown): Record<string, unknown> {
    return parseWithSchema(UnknownRecordSchema, value) ?? {};
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
    return parseWithSchema(BooleanSchema, value) ?? fallback;
}

function parsePercent(value: unknown, fallback: number): number {
    const parsed = parseWithSchema(NumberSchema, value);
    if (parsed === undefined) return fallback;
    return Math.min(99, Math.max(1, Math.trunc(parsed)));
}

function parseNonEmptyString(value: unknown, fallback: string): string {
    const parsed = parseWithSchema(StringSchema, value);
    if (parsed === undefined) return fallback;
    const text = parsed.trim();
    return text.length > 0 ? text : fallback;
}

function parseStringEnum<const TValue extends string>(
    value: unknown,
    allowed: readonly TValue[],
): TValue | undefined {
    const parsed = parseWithSchema(StringSchema, value);
    return parsed !== undefined && (allowed as readonly string[]).includes(parsed)
        ? (parsed as TValue)
        : undefined;
}
