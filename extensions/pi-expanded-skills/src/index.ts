import { reportExtensionDiagnostic } from "@zigai/pi-extension-internals";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseDocument } from "yaml";
import { registerSystemPromptPreparation } from "@zigai/pi-extension-internals/prompt-preparation";

import {
    type AgentStartEvent,
    type BuildSystemPromptOptions,
    type SessionShutdownEvent,
    type BeforeAgentStartEvent,
    type BeforeAgentStartEventResult,
    type BeforeProviderRequestEvent,
    type BeforeProviderRequestEventResult,
    getAgentDir,
    isReadToolResult,
    parseFrontmatter,
    type SessionStartEvent,
    type ToolResultEvent,
    type ContextEvent,
    type ExtensionContext,
    type ExtensionAPI,
    type InputEvent,
    type InputSource,
    type InputEventResult,
    type Skill,
    type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";

/** Package display name used in user-visible extension messages. */
export const extensionName = "Pi Enhanced Skills";

/** Generated npm package name. */
export const packageName = "pi-enhanced-skills";

const INLINE_COMMAND_PATTERN = /(^|[ \t])!`([^`\r\n]+)`/gm;
const FENCED_COMMAND_PATTERN = /^([ \t]*)```![ \t]*\r?\n([\s\S]*?)^\1```[ \t]*$/gm;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const MAX_COMMAND_OUTPUT_CHARS = 12_000;
const SKILL_USAGE_SCHEMA_VERSION = 1;
const SKILL_USAGE_STATE_DIR = "state";
const SKILL_USAGE_LOG_FILE = "skill-usage.jsonl";
const MARKDOWN_INLINE_LINK_PATTERN = /!?\[[^\]\r\n]*\]\(([^)\r\n]+)\)/g;
const MARKDOWN_REFERENCE_LINK_PATTERN = /^[ \t]*\[[^\]\r\n]+\]:[ \t]*(\S+)/gm;
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const SKILL_BLOCK_OPEN_PATTERN = /<skill name="([^"]+)" location="([^"]+)">/g;

type DynamicShell = "bash" | "powershell";

type SkillMetadata = {
    readonly disableModelInvocation: boolean;
    readonly userInvocable: boolean;
    readonly shell: DynamicShell;
};

type DynamicCommandResult = {
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number;
    readonly killed: boolean;
};

type DynamicCommandExecutor = (
    command: string,
    shell: DynamicShell,
    cwd: string,
) => Promise<DynamicCommandResult>;

type CompletionItem = {
    readonly value: string;
    readonly label: string;
    readonly description?: string;
};

type CompletionSuggestions = {
    readonly items: CompletionItem[];
    readonly prefix: string;
};

type ExtensionOptions = {
    readonly skillUsageStore?: SkillUsageStore;
};

export type SkillExtensionContext = Pick<ExtensionContext, "cwd" | "hasUI" | "abort"> & {
    readonly model:
        | {
              readonly provider: string;
              readonly id: string;
          }
        | undefined;
    readonly sessionManager: Pick<
        ExtensionContext["sessionManager"],
        "getSessionFile" | "getSessionId"
    >;
    readonly ui: Pick<ExtensionContext["ui"], "addAutocompleteProvider" | "notify">;
};

type SkillExtensionHandler<TEvent, TResult = undefined> = (
    event: TEvent,
    ctx: SkillExtensionContext,
) => Promise<TResult | void> | TResult | void;

export type SkillExtensionEventHandlers = {
    readonly agent_start: SkillExtensionHandler<AgentStartEvent>;
    readonly before_agent_start: SkillExtensionHandler<
        BeforeAgentStartEvent,
        BeforeAgentStartEventResult
    >;
    readonly before_provider_request: SkillExtensionHandler<
        BeforeProviderRequestEvent,
        BeforeProviderRequestEventResult
    >;
    readonly context: SkillExtensionHandler<
        ContextEvent,
        { readonly messages?: ContextEvent["messages"] }
    >;
    readonly input: SkillExtensionHandler<InputEvent, InputEventResult>;
    readonly session_start: SkillExtensionHandler<SessionStartEvent>;
    readonly session_shutdown: SkillExtensionHandler<SessionShutdownEvent>;
    readonly tool_result: SkillExtensionHandler<
        ToolResultEvent,
        {
            readonly content?: ToolResultEvent["content"];
            readonly details?: unknown;
            readonly isError?: boolean;
        }
    >;
};

export type SkillExtensionAPI = Pick<ExtensionAPI, "exec" | "getCommands" | "events"> & {
    on<TEvent extends keyof SkillExtensionEventHandlers>(
        event: TEvent,
        handler: SkillExtensionEventHandlers[TEvent],
    ): void;
};

type SkillUsageStore = {
    readonly record: (record: SkillUsageRecord) => Promise<void>;
};

type SkillFileRole = "main" | "referenced" | "skill-directory-file";

type SkillUsageModel = {
    readonly provider: string;
    readonly id: string;
};

type SkillUsageContextFields = {
    readonly sessionId: string;
    readonly sessionFile?: string;
    readonly model?: SkillUsageModel;
    readonly projectFolder: string;
};

type SkillUsageRead = {
    readonly toolCallId: string;
    readonly offset?: number;
    readonly limit?: number;
};

type SkillUsageInvocation = {
    readonly inputSource: InputSource;
    readonly hasArguments: boolean;
};

type SkillUsageMention = {
    readonly source: "context" | "provider_payload";
};

type SkillUsageRecord = SkillUsageContextFields & {
    readonly schemaVersion: typeof SKILL_USAGE_SCHEMA_VERSION;
    readonly timestamp: string;
    readonly event: "agent_read" | "mention_expansion" | "user_invocation";
    readonly skillName: string;
    readonly skillPath: string;
    readonly skillBaseDir: string;
    readonly filePath: string;
    readonly relativePath: string;
    readonly fileRole: SkillFileRole;
    readonly commandSource: {
        readonly source: string;
        readonly scope: string;
        readonly origin: string;
    };
    readonly read?: SkillUsageRead;
    readonly invocation?: SkillUsageInvocation;
    readonly mention?: SkillUsageMention;
};

type SkillFileTarget = {
    readonly command: SlashCommandInfo;
    readonly skillName: string;
    readonly skillPath: string;
    readonly skillBaseDir: string;
    readonly filePath: string;
    readonly relativePath: string;
    readonly fileRole: SkillFileRole;
};

type ReadResultInput = {
    readonly path: string;
    readonly offset?: number;
    readonly limit?: number;
};

type ReferencedSkillFileCache = Map<string, Promise<ReadonlySet<string>>>;

type MentionSkillBlock = {
    readonly names: readonly string[];
    readonly location: string;
};

type TextBlockLike = {
    readonly type: "text";
    readonly text: string;
};

/** Register enhanced cross-harness skill behavior. */
export default function extension(pi: SkillExtensionAPI, options?: ExtensionOptions): void {
    const skillUsageStore =
        options?.skillUsageStore ?? createJsonlSkillUsageStore(defaultSkillUsageLogPath());
    const referencedSkillFiles = new Map<string, Promise<ReadonlySet<string>>>();
    const seenMentionExpansionKeys = new Set<string>();

    let generation = 0;
    let active = true;
    const ownedSkillUsageStore = (ctx: SkillExtensionContext): SkillUsageStore => {
        const current = generation;
        return {
            async record(record) {
                if (!active || current !== generation) return;
                try {
                    await skillUsageStore.record(record);
                } catch (cause: unknown) {
                    if (!active || current !== generation) return;
                    reportExtensionDiagnostic(
                        `[${packageName}] Failed to persist skill usage: ${formatSafeErrorSummary(cause)}`,
                        "warning",
                        ctx,
                    );
                }
            },
        };
    };
    let preparations = new WeakMap<BuildSystemPromptOptions, Promise<void>>();
    const prepareSkills = (
        input: BuildSystemPromptOptions,
        current = generation,
    ): Promise<void> => {
        if (!active || current !== generation) return Promise.resolve();
        const pending = preparations.get(input);
        if (pending !== undefined) return pending;
        const operation = (async () => {
            const skills = input.skills ?? [];
            const filtered: Skill[] = [];
            const metadataErrors: unknown[] = [];
            for (const skill of skills) {
                try {
                    const metadata = await loadSkillMetadata(skill.filePath, skill);
                    if (metadata !== undefined && !metadata.disableModelInvocation) {
                        filtered.push(skill);
                    }
                } catch (cause: unknown) {
                    metadataErrors.push(cause);
                }
            }

            if (active && current === generation && filtered.length !== skills.length)
                input.skills = filtered;
            if (metadataErrors.length > 0) {
                throw new AggregateError(
                    metadataErrors,
                    `Unable to validate skill metadata:\n${metadataErrors.map(String).join("\n")}`,
                );
            }
        })();
        preparations.set(input, operation);
        return operation;
    };
    const registerPreparation = () => {
        const current = generation;
        return registerSystemPromptPreparation(pi.events, (input) => prepareSkills(input, current));
    };
    let unregisterPreparation = registerPreparation();

    pi.on("before_agent_start", async (event, ctx) => {
        const current = generation;
        try {
            await prepareSkills(event.systemPromptOptions, current);
        } catch (cause) {
            if (active && current === generation) ctx.abort();
            throw cause;
        }
    });
    pi.on("session_shutdown", () => {
        unregisterPreparation();
        active = false;
        generation += 1;
        preparations = new WeakMap();
    });

    pi.on("input", async (event, ctx): Promise<InputEventResult | void> => {
        const usageStore = ownedSkillUsageStore(ctx);
        const invocation = parseSkillInvocation(event.text);
        if (!invocation) {
            return;
        }

        const command = findSkillCommand(pi.getCommands(), invocation.name);
        if (!command) {
            return;
        }

        const metadata = await loadSkillMetadata(command.sourceInfo.path);
        if (metadata === undefined) {
            if (ctx.hasUI) {
                ctx.ui.notify(`Skill "${invocation.name}" is no longer available.`, "warning");
            }
            return { action: "handled" };
        }

        if (!metadata.userInvocable) {
            if (ctx.hasUI) {
                ctx.ui.notify(`Skill "${invocation.name}" is not user-invocable.`, "warning");
            }
            return { action: "handled" };
        }

        const rawContent = await readSkillFile(command.sourceInfo.path);
        if (rawContent === undefined) {
            if (ctx.hasUI) {
                ctx.ui.notify(`Skill "${invocation.name}" is no longer available.`, "warning");
            }
            return { action: "handled" };
        }

        const renderedContent = await renderSkillContent(
            rawContent,
            dirname(command.sourceInfo.path),
            createPiCommandExecutor(pi),
        );
        const text = appendSkillArguments(renderedContent, invocation.args);

        await recordSkillUsage(usageStore, {
            ctx,
            event: "user_invocation",
            invocation: {
                inputSource: event.source,
                hasArguments: invocation.args.trim().length > 0,
            },
            target: makeSkillMainFileTarget(command),
        });

        return event.images === undefined
            ? {
                  action: "transform",
                  text,
              }
            : {
                  action: "transform",
                  text,
                  images: event.images,
              };
    });

    pi.on("tool_result", async (event, ctx) => {
        const usageStore = ownedSkillUsageStore(ctx);
        if (!isReadToolResult(event) || event.isError) {
            return;
        }

        const readInput = parseReadResultInput(event.input);
        if (!readInput) {
            return;
        }

        const inputPath = resolveReadInputPath(readInput.path, ctx.cwd);
        const target = await findSkillFileTarget(pi.getCommands(), inputPath, referencedSkillFiles);
        if (!target) {
            return;
        }

        await recordSkillUsage(usageStore, {
            ctx,
            event: "agent_read",
            read: {
                toolCallId: event.toolCallId,
                ...(readInput.offset === undefined ? {} : { offset: readInput.offset }),
                ...(readInput.limit === undefined ? {} : { limit: readInput.limit }),
            },
            target,
        });

        if (
            target.fileRole !== "main" ||
            readInput.offset !== undefined ||
            readInput.limit !== undefined
        ) {
            return;
        }

        const textContent = event.content.find((content) => content.type === "text");
        if (!textContent) {
            return;
        }

        if (!containsDynamicCommands(textContent.text)) {
            return;
        }

        const metadata = await loadSkillMetadata(target.skillPath);
        const renderedText = await renderSkillContent(
            textContent.text,
            target.skillBaseDir,
            createPiCommandExecutor(pi),
            metadata?.shell,
        );
        return {
            content: event.content.map((content) =>
                content === textContent
                    ? {
                          ...content,
                          text: renderedText,
                      }
                    : content,
            ),
            details: event.details,
            isError: event.isError,
        };
    });

    pi.on("agent_start", () => {
        seenMentionExpansionKeys.clear();
    });

    pi.on("context", async (event, ctx) => {
        await recordMentionSkillUsageFromTexts(ownedSkillUsageStore(ctx), {
            commands: pi.getCommands(),
            ctx,
            seenMentionExpansionKeys,
            source: "context",
            texts: collectContextSkillBlockTexts(event.messages),
        });
    });

    pi.on("before_provider_request", async (event, ctx) => {
        await recordMentionSkillUsageFromTexts(ownedSkillUsageStore(ctx), {
            commands: pi.getCommands(),
            ctx,
            seenMentionExpansionKeys,
            source: "provider_payload",
            texts: collectUnknownSkillBlockTexts(event.payload),
        });
    });

    pi.on("session_start", (_event, ctx) => {
        unregisterPreparation();
        generation += 1;
        active = true;
        preparations = new WeakMap();
        unregisterPreparation = registerPreparation();
        if (!ctx.hasUI) {
            return;
        }

        ctx.ui.addAutocompleteProvider((current) => ({
            ...(current.triggerCharacters === undefined
                ? {}
                : { triggerCharacters: current.triggerCharacters }),
            getSuggestions: async (lines, cursorLine, cursorCol, options) => {
                const suggestions = await current.getSuggestions(
                    lines,
                    cursorLine,
                    cursorCol,
                    options,
                );
                if (!isSkillSuggestionContext(lines, cursorLine, cursorCol) || !suggestions) {
                    return suggestions;
                }

                return filterUserInvocableSuggestions(suggestions, pi.getCommands());
            },
            applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
                current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
            shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
                current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true,
        }));
    });
}

function createJsonlSkillUsageStore(filePath: string): SkillUsageStore {
    let previousWrite = Promise.resolve();
    return {
        async record(record) {
            const line = `${JSON.stringify(record)}\n`;
            const write = previousWrite
                .catch(() => undefined)
                .then(async () => {
                    await mkdir(dirname(filePath), { recursive: true });
                    await appendFile(filePath, line, { encoding: "utf-8", flag: "a" });
                });
            previousWrite = write;
            await write;
        },
    };
}

function defaultSkillUsageLogPath(): string {
    return join(getAgentDir(), SKILL_USAGE_STATE_DIR, packageName, SKILL_USAGE_LOG_FILE);
}

async function recordSkillUsage(
    store: SkillUsageStore,
    input: {
        readonly ctx: SkillExtensionContext;
        readonly event: SkillUsageRecord["event"];
        readonly target: SkillFileTarget;
        readonly read?: SkillUsageRead;
        readonly invocation?: SkillUsageInvocation;
        readonly mention?: SkillUsageMention;
    },
): Promise<void> {
    await store.record(makeSkillUsageRecord(input));
}

function makeSkillUsageRecord(input: {
    readonly ctx: SkillExtensionContext;
    readonly event: SkillUsageRecord["event"];
    readonly target: SkillFileTarget;
    readonly read?: SkillUsageRead;
    readonly invocation?: SkillUsageInvocation;
    readonly mention?: SkillUsageMention;
}): SkillUsageRecord {
    return {
        schemaVersion: SKILL_USAGE_SCHEMA_VERSION,
        timestamp: new Date().toISOString(),
        event: input.event,
        ...makeSkillUsageContextFields(input.ctx),
        skillName: input.target.skillName,
        skillPath: input.target.skillPath,
        skillBaseDir: input.target.skillBaseDir,
        filePath: input.target.filePath,
        relativePath: input.target.relativePath,
        fileRole: input.target.fileRole,
        commandSource: {
            source: input.target.command.sourceInfo.source,
            scope: input.target.command.sourceInfo.scope,
            origin: input.target.command.sourceInfo.origin,
        },
        ...(input.read === undefined ? {} : { read: input.read }),
        ...(input.invocation === undefined ? {} : { invocation: input.invocation }),
        ...(input.mention === undefined ? {} : { mention: input.mention }),
    };
}

async function recordMentionSkillUsageFromTexts(
    store: SkillUsageStore,
    input: {
        readonly commands: readonly SlashCommandInfo[];
        readonly ctx: SkillExtensionContext;
        readonly seenMentionExpansionKeys: Set<string>;
        readonly source: SkillUsageMention["source"];
        readonly texts: readonly string[];
    },
): Promise<void> {
    for (const text of input.texts) {
        const fingerprint = hashSkillUsageSource(text);
        const blocks = extractMentionSkillBlocks(text);
        for (const block of blocks) {
            for (const target of findMentionSkillTargets(input.commands, block)) {
                const key = `${input.ctx.sessionManager.getSessionId()}:${fingerprint}:${target.skillPath}`;
                if (input.seenMentionExpansionKeys.has(key)) {
                    continue;
                }

                input.seenMentionExpansionKeys.add(key);
                await recordSkillUsage(store, {
                    ctx: input.ctx,
                    event: "mention_expansion",
                    mention: { source: input.source },
                    target,
                });
            }
        }
    }
}

function collectContextSkillBlockTexts(messages: ContextEvent["messages"]): string[] {
    const texts: string[] = [];
    for (const message of messages) {
        if (message.role !== "user") {
            continue;
        }

        if (typeof message.content === "string") {
            if (message.content.includes("<skill ")) {
                texts.push(message.content);
            }
            continue;
        }

        for (const block of message.content) {
            if (isTextBlockLike(block) && block.text.includes("<skill ")) {
                texts.push(block.text);
            }
        }
    }
    return texts;
}

function collectUnknownSkillBlockTexts(value: unknown): string[] {
    const texts: string[] = [];
    collectUnknownSkillBlockTextsInto(value, texts, 0);
    return texts;
}

function collectUnknownSkillBlockTextsInto(value: unknown, texts: string[], depth: number): void {
    if (depth > 8) {
        return;
    }

    if (typeof value === "string") {
        if (value.includes("<skill ")) {
            texts.push(value);
        }
        return;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectUnknownSkillBlockTextsInto(item, texts, depth + 1);
        }
        return;
    }

    if (!isUnknownRecord(value)) {
        return;
    }

    for (const item of Object.values(value)) {
        collectUnknownSkillBlockTextsInto(item, texts, depth + 1);
    }
}

function isTextBlockLike(value: unknown): value is TextBlockLike {
    if (!isUnknownRecord(value)) {
        return false;
    }
    return value.type === "text" && typeof value.text === "string";
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function decodeSkillAttribute(value: string): string {
    return value
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&");
}

function extractMentionSkillBlocks(text: string): MentionSkillBlock[] {
    SKILL_BLOCK_OPEN_PATTERN.lastIndex = 0;
    const blocks: MentionSkillBlock[] = [];
    for (const match of text.matchAll(SKILL_BLOCK_OPEN_PATTERN)) {
        const names = decodeSkillAttribute(match[1] ?? "")
            .split(",")
            .map((name) => name.trim())
            .filter((name) => name.length > 0);
        const location = decodeSkillAttribute(match[2] ?? "");
        if (names.length > 0 && location.length > 0) {
            blocks.push({ names, location });
        }
    }
    SKILL_BLOCK_OPEN_PATTERN.lastIndex = 0;
    return blocks;
}

function findMentionSkillTargets(
    commands: readonly SlashCommandInfo[],
    block: MentionSkillBlock,
): SkillFileTarget[] {
    const targets: SkillFileTarget[] = [];
    const seenPaths = new Set<string>();

    for (const name of block.names) {
        const command = findSkillCommand(commands, name);
        if (!command) {
            continue;
        }

        const target = makeSkillMainFileTarget(command);
        seenPaths.add(target.skillPath);
        targets.push(target);
    }

    if (block.location === "multiple") {
        return targets;
    }

    const locationPath = resolve(block.location);
    if (seenPaths.has(locationPath)) {
        return targets;
    }

    const command = commands.find(
        (candidate) =>
            candidate.source === "skill" && resolve(candidate.sourceInfo.path) === locationPath,
    );
    if (!command) {
        return targets;
    }

    targets.push(makeSkillMainFileTarget(command));
    return targets;
}

function hashSkillUsageSource(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

function makeSkillUsageContextFields(ctx: SkillExtensionContext): SkillUsageContextFields {
    const sessionFile = ctx.sessionManager.getSessionFile();
    const model = ctx.model === undefined ? undefined : formatSkillUsageModel(ctx.model);
    return {
        sessionId: ctx.sessionManager.getSessionId(),
        projectFolder: ctx.cwd,
        ...(sessionFile === undefined ? {} : { sessionFile }),
        ...(model === undefined ? {} : { model }),
    };
}

function formatSkillUsageModel(model: {
    readonly provider: string;
    readonly id: string;
}): SkillUsageModel {
    return {
        provider: model.provider,
        id: model.id,
    };
}

function parseReadResultInput(input: Record<string, unknown>): ReadResultInput | undefined {
    if (typeof input.path !== "string") {
        return undefined;
    }

    return {
        path: input.path,
        ...(typeof input.offset === "number" ? { offset: input.offset } : {}),
        ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
    };
}

function resolveReadInputPath(path: string, cwd: string): string {
    const normalizedPath = path.startsWith("@") ? path.slice(1) : path;
    return resolve(cwd, normalizedPath);
}

async function findSkillFileTarget(
    commands: readonly SlashCommandInfo[],
    filePath: string,
    referencedSkillFiles: ReferencedSkillFileCache,
): Promise<SkillFileTarget | undefined> {
    const skills = commands
        .filter((command) => command.source === "skill")
        .map((command) => ({
            command,
            skillPath: resolve(command.sourceInfo.path),
            skillBaseDir: resolve(command.sourceInfo.baseDir ?? dirname(command.sourceInfo.path)),
        }))
        .sort((left, right) => right.skillBaseDir.length - left.skillBaseDir.length);

    for (const skill of skills) {
        if (filePath === skill.skillPath) {
            return makeSkillFileTarget(skill.command, skill.skillPath, skill.skillBaseDir, "main");
        }

        if (!isPathInDirectory(skill.skillBaseDir, filePath)) {
            continue;
        }

        const referencedFiles = await loadReferencedSkillFilePaths(
            skill.skillPath,
            skill.skillBaseDir,
            referencedSkillFiles,
        );
        return makeSkillFileTarget(
            skill.command,
            skill.skillPath,
            skill.skillBaseDir,
            referencedFiles.has(filePath) ? "referenced" : "skill-directory-file",
            filePath,
        );
    }

    return undefined;
}

function makeSkillMainFileTarget(command: SlashCommandInfo): SkillFileTarget {
    const skillPath = resolve(command.sourceInfo.path);
    const skillBaseDir = resolve(command.sourceInfo.baseDir ?? dirname(command.sourceInfo.path));
    return makeSkillFileTarget(command, skillPath, skillBaseDir, "main");
}

function makeSkillFileTarget(
    command: SlashCommandInfo,
    skillPath: string,
    skillBaseDir: string,
    fileRole: SkillFileRole,
    filePath = skillPath,
): SkillFileTarget {
    return {
        command,
        skillName: normalizeSkillCommandName(command),
        skillPath,
        skillBaseDir,
        filePath,
        relativePath: relative(skillBaseDir, filePath) || ".",
        fileRole,
    };
}

function normalizeSkillCommandName(command: SlashCommandInfo): string {
    return command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
}

async function loadReferencedSkillFilePaths(
    skillPath: string,
    skillBaseDir: string,
    cache: ReferencedSkillFileCache,
): Promise<ReadonlySet<string>> {
    const cached = cache.get(skillPath);
    if (cached) {
        return cached;
    }

    const loaded = (async () => {
        try {
            const content = await readFile(skillPath, "utf-8");
            return extractReferencedSkillFilePaths(content, skillBaseDir);
        } catch {
            return new Set<string>();
        }
    })();
    cache.set(skillPath, loaded);
    return loaded;
}

function extractReferencedSkillFilePaths(
    content: string,
    skillBaseDir: string,
): ReadonlySet<string> {
    const references = new Set<string>();
    for (const pattern of [MARKDOWN_INLINE_LINK_PATTERN, MARKDOWN_REFERENCE_LINK_PATTERN]) {
        pattern.lastIndex = 0;
        for (const match of content.matchAll(pattern)) {
            const reference = resolveSkillReference(match[1] ?? "", skillBaseDir);
            if (reference) {
                references.add(reference);
            }
        }
        pattern.lastIndex = 0;
    }
    return references;
}

function resolveSkillReference(rawTarget: string, skillBaseDir: string): string | undefined {
    const target = parseMarkdownLinkTarget(rawTarget);
    if (
        !target ||
        target.startsWith("#") ||
        target.startsWith("//") ||
        URL_SCHEME_PATTERN.test(target)
    ) {
        return undefined;
    }

    const pathPart = target.split(/[?#]/, 1)[0] ?? "";
    if (!pathPart) {
        return undefined;
    }

    const resolvedPath = resolve(skillBaseDir, pathPart);
    return isPathInDirectory(skillBaseDir, resolvedPath) ? resolvedPath : undefined;
}

function parseMarkdownLinkTarget(rawTarget: string): string {
    const trimmedTarget = rawTarget.trim();
    if (trimmedTarget.startsWith("<")) {
        const end = trimmedTarget.indexOf(">");
        if (end > 0) {
            return trimmedTarget.slice(1, end);
        }
    }

    const firstWhitespace = trimmedTarget.search(/[ \t]/);
    return firstWhitespace === -1 ? trimmedTarget : trimmedTarget.slice(0, firstWhitespace);
}

function isPathInDirectory(parentPath: string, childPath: string): boolean {
    const childRelativePath = relative(parentPath, childPath);
    return (
        childRelativePath.length > 0 &&
        !childRelativePath.startsWith("..") &&
        !isAbsolute(childRelativePath)
    );
}

function formatSafeErrorSummary(cause: unknown): string {
    if (cause instanceof Error) {
        return `${cause.name}: ${cause.message}`;
    }
    return typeof cause;
}

async function loadSkillMetadata(
    filePath: string,
    loadedSkill?: Skill,
): Promise<SkillMetadata | undefined> {
    const rawContent = await readSkillFile(filePath);
    if (rawContent === undefined) {
        return undefined;
    }

    const { frontmatter } = parseFrontmatter(rawContent);
    const allowImplicitInvocation = await loadOpenAiAllowImplicitInvocation(dirname(filePath));
    const frontmatterDisableModelInvocation =
        loadedSkill?.disableModelInvocation ?? frontmatter["disable-model-invocation"] === true;

    return {
        disableModelInvocation:
            frontmatterDisableModelInvocation || allowImplicitInvocation === false,
        userInvocable: frontmatter["user-invocable"] !== false,
        shell: parseDynamicShell(frontmatter.shell),
    };
}

async function readSkillFile(filePath: string): Promise<string | undefined> {
    try {
        return await readFile(filePath, "utf-8");
    } catch (cause: unknown) {
        if (isNodeError(cause) && cause.code === "ENOENT") {
            return undefined;
        }
        throw cause;
    }
}

async function loadOpenAiAllowImplicitInvocation(skillDir: string): Promise<boolean | undefined> {
    const sidecarPath = join(skillDir, "agents", "openai.yaml");
    let rawContent: string;
    try {
        rawContent = await readFile(sidecarPath, "utf-8");
    } catch (cause: unknown) {
        if (isNodeError(cause) && cause.code === "ENOENT") {
            return undefined;
        }
        throw cause;
    }

    return parseOpenAiAllowImplicitInvocation(rawContent);
}

export function parseOpenAiAllowImplicitInvocation(rawContent: string): boolean | undefined {
    const document = parseDocument(rawContent);
    if (document.errors.length !== 0) {
        throw new Error("Invalid OpenAI skill policy YAML");
    }
    let parsed: unknown;
    try {
        parsed = document.toJS();
    } catch {
        throw new Error("Invalid OpenAI skill policy YAML");
    }
    if (!isUnknownRecord(parsed) || !isUnknownRecord(parsed.policy)) {
        return undefined;
    }
    const value = parsed.policy.allow_implicit_invocation;
    if (typeof value === "boolean") {
        return value;
    }
    return undefined;
}

export async function renderSkillContent(
    content: string,
    cwd: string,
    executeCommand: DynamicCommandExecutor,
    shell?: DynamicShell,
): Promise<string> {
    const effectiveShell = shell ?? parseDynamicShell(parseFrontmatter(content).frontmatter.shell);
    FENCED_COMMAND_PATTERN.lastIndex = 0;
    const fencedMatches = Array.from(content.matchAll(FENCED_COMMAND_PATTERN));
    FENCED_COMMAND_PATTERN.lastIndex = 0;
    const fencedOutputs: { readonly start: number; readonly end: number; readonly text: string }[] =
        [];
    for (const match of fencedMatches) {
        const output = await runDynamicCommand(
            (match[2] ?? "").trim(),
            effectiveShell,
            cwd,
            executeCommand,
        );
        fencedOutputs.push({
            start: match.index,
            end: match.index + match[0].length,
            text: `${match[1] ?? ""}${output}`,
        });
    }

    const renderInline = (text: string): Promise<string> =>
        replaceAsync(text, INLINE_COMMAND_PATTERN, async (_match, prefix, command) => {
            const output = await runDynamicCommand(
                command.trim(),
                effectiveShell,
                cwd,
                executeCommand,
            );
            return `${prefix}${output}`;
        });

    let rendered = "";
    let cursor = 0;
    for (const fenced of fencedOutputs) {
        rendered += await renderInline(content.slice(cursor, fenced.start));
        rendered += fenced.text;
        cursor = fenced.end;
    }
    return rendered + (await renderInline(content.slice(cursor)));
}

function createPiCommandExecutor(pi: Pick<SkillExtensionAPI, "exec">): DynamicCommandExecutor {
    return async (command, shell, cwd) => {
        const [executable, args] = makeShellCommand(shell, command);
        return pi.exec(executable, args, {
            cwd,
            timeout: DEFAULT_COMMAND_TIMEOUT_MS,
        });
    };
}

function makeShellCommand(shell: DynamicShell, command: string): readonly [string, string[]] {
    if (shell === "powershell") {
        return ["pwsh", ["-NoProfile", "-Command", command]];
    }
    return ["bash", ["-lc", command]];
}

async function runDynamicCommand(
    command: string,
    shell: DynamicShell,
    cwd: string,
    executeCommand: DynamicCommandExecutor,
): Promise<string> {
    if (!command) {
        return "[skill command skipped: empty command]";
    }

    const result = await executeCommand(command, shell, cwd);
    if (result.code === 0 && !result.killed) {
        return truncateCommandOutput(result.stdout);
    }

    const parts = [
        `[skill command failed: ${result.killed ? "timed out" : `exit ${result.code}`}]`,
    ];
    if (result.stdout) {
        parts.push("stdout:", result.stdout.trimEnd());
    }
    if (result.stderr) {
        parts.push("stderr:", result.stderr.trimEnd());
    }
    return truncateCommandOutput(parts.join("\n"));
}

function truncateCommandOutput(output: string): string {
    if (output.length <= MAX_COMMAND_OUTPUT_CHARS) {
        return output.trimEnd();
    }

    const omittedChars = output.length - MAX_COMMAND_OUTPUT_CHARS;
    return `${output.slice(0, MAX_COMMAND_OUTPUT_CHARS).trimEnd()}\n[skill command output truncated: ${omittedChars} characters omitted]`;
}

async function replaceAsync(
    input: string,
    pattern: RegExp,
    replacement: (...args: string[]) => Promise<string>,
): Promise<string> {
    pattern.lastIndex = 0;
    const matches = Array.from(input.matchAll(pattern));
    pattern.lastIndex = 0;
    if (matches.length === 0) {
        return input;
    }

    let output = "";
    let cursor = 0;
    for (const match of matches) {
        output += input.slice(cursor, match.index);
        output += await replacement(...match.map((value) => value ?? ""));
        cursor = (match.index ?? 0) + match[0].length;
    }
    output += input.slice(cursor);
    return output;
}

function parseDynamicShell(value: unknown): DynamicShell {
    return value === "powershell" ? "powershell" : "bash";
}

function containsDynamicCommands(content: string): boolean {
    INLINE_COMMAND_PATTERN.lastIndex = 0;
    FENCED_COMMAND_PATTERN.lastIndex = 0;
    return INLINE_COMMAND_PATTERN.test(content) || FENCED_COMMAND_PATTERN.test(content);
}

function parseSkillInvocation(
    text: string,
): { readonly name: string; readonly args: string } | undefined {
    const match = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
    if (!match) {
        return undefined;
    }

    return {
        name: match[1] ?? "",
        args: match[2] ?? "",
    };
}

function appendSkillArguments(content: string, args: string): string {
    const trimmedArgs = args.trim();
    if (!trimmedArgs) {
        return content;
    }

    return `${content}\n\nUser: ${trimmedArgs}`;
}

function findSkillCommand(
    commands: readonly SlashCommandInfo[],
    skillName: string,
): SlashCommandInfo | undefined {
    return commands.find(
        (command) => command.source === "skill" && command.name === `skill:${skillName}`,
    );
}

function isSkillSuggestionContext(
    lines: readonly string[],
    cursorLine: number,
    cursorCol: number,
): boolean {
    const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
    return /^\/skill:[^\s]*$/.test(beforeCursor);
}

async function filterUserInvocableSuggestions(
    suggestions: CompletionSuggestions,
    commands: readonly SlashCommandInfo[],
): Promise<CompletionSuggestions> {
    const hiddenNames = new Set<string>();
    await Promise.all(
        commands
            .filter((command) => command.source === "skill")
            .map(async (command) => {
                const metadata = await loadSkillMetadata(command.sourceInfo.path);
                if (metadata === undefined || !metadata.userInvocable) {
                    hiddenNames.add(command.name);
                }
            }),
    );

    return {
        ...suggestions,
        items: suggestions.items.filter(
            (item) => !hiddenNames.has(normalizeSuggestionCommandName(item)),
        ),
    };
}

function normalizeSuggestionCommandName(item: CompletionItem): string {
    const candidate = item.value || item.label;
    return candidate.startsWith("/") ? candidate.slice(1) : candidate;
}

function isNodeError(cause: unknown): cause is NodeJS.ErrnoException {
    return cause instanceof Error && "code" in cause;
}

export const internals = {
    appendSkillArguments,
    containsDynamicCommands,
    defaultSkillUsageLogPath,
    extractReferencedSkillFilePaths,
    filterUserInvocableSuggestions,
    parseSkillInvocation,
    parseDynamicShell,
    truncateCommandOutput,
};
