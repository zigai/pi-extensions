import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
    formatSkillsForPrompt,
    isReadToolResult,
    parseFrontmatter,
    type ExtensionAPI,
    type InputEventResult,
    type Skill,
    type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";

/** Package display name used in user-visible extension messages. */
export const extensionName = "Pi Expanded Skills";

/** Generated npm package name. */
export const packageName = "pi-expanded-skills";

const INLINE_COMMAND_PATTERN = /(^|[ \t])!`([^`\r\n]+)`/gm;
const FENCED_COMMAND_PATTERN = /^([ \t]*)```![ \t]*\r?\n([\s\S]*?)^\1```[ \t]*$/gm;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const MAX_COMMAND_OUTPUT_CHARS = 12_000;

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

/** Register expanded cross-harness skill behavior. */
export default function extension(pi: ExtensionAPI): void {
    pi.on("before_agent_start", async (event) => {
        const filteredSkills = await filterModelInvocableSkills(
            event.systemPromptOptions.skills ?? [],
        );
        if (filteredSkills.length === (event.systemPromptOptions.skills ?? []).length) {
            return;
        }

        const originalSkillsPrompt = formatSkillsForPrompt(event.systemPromptOptions.skills ?? []);
        if (!originalSkillsPrompt) {
            return;
        }

        return {
            systemPrompt: event.systemPrompt.replace(
                originalSkillsPrompt,
                formatSkillsForPrompt(filteredSkills),
            ),
        };
    });

    pi.on("input", async (event, ctx): Promise<InputEventResult | void> => {
        const invocation = parseSkillInvocation(event.text);
        if (!invocation) {
            return;
        }

        const command = findSkillCommand(pi.getCommands(), invocation.name);
        if (!command) {
            return;
        }

        const metadata = await loadSkillMetadata(command.sourceInfo.path);
        if (!metadata.userInvocable) {
            if (ctx.hasUI) {
                ctx.ui.notify(`Skill "${invocation.name}" is not user-invocable.`, "warning");
            }
            return { action: "handled" };
        }

        const rawContent = await readFile(command.sourceInfo.path, "utf-8");
        const renderedContent = await renderSkillContent(
            rawContent,
            dirname(command.sourceInfo.path),
            createPiCommandExecutor(pi),
        );
        const text = appendSkillArguments(renderedContent, invocation.args);

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

    pi.on("tool_result", async (event) => {
        if (
            !isReadToolResult(event) ||
            event.isError ||
            event.input.offset !== undefined ||
            event.input.limit !== undefined
        ) {
            return;
        }

        const inputPath = resolve(String(event.input.path));
        if (!isKnownSkillPath(pi.getCommands(), inputPath)) {
            return;
        }

        const textContent = event.content.find((content) => content.type === "text");
        if (!textContent) {
            return;
        }

        if (!containsDynamicCommands(textContent.text)) {
            return;
        }

        const metadata = await loadSkillMetadata(inputPath);
        const renderedText = await renderSkillContent(
            textContent.text,
            dirname(inputPath),
            createPiCommandExecutor(pi),
            metadata.shell,
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

    pi.on("session_start", (_event, ctx) => {
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

async function filterModelInvocableSkills(skills: readonly Skill[]): Promise<Skill[]> {
    const filtered: Skill[] = [];
    for (const skill of skills) {
        const metadata = await loadSkillMetadata(skill.filePath, skill);
        if (!metadata.disableModelInvocation) {
            filtered.push(skill);
        }
    }
    return filtered;
}

async function loadSkillMetadata(filePath: string, loadedSkill?: Skill): Promise<SkillMetadata> {
    const rawContent = await readFile(filePath, "utf-8");
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
    const lines = rawContent.split(/\r?\n/);
    let inPolicy = false;
    let policyIndent = 0;

    for (const line of lines) {
        const withoutComment = line.replace(/[ \t]+#.*$/, "");
        if (!withoutComment.trim()) {
            continue;
        }

        const indent = withoutComment.search(/\S/);
        const trimmed = withoutComment.trim();
        if (/^policy\s*:\s*$/.test(trimmed)) {
            inPolicy = true;
            policyIndent = indent;
            continue;
        }

        if (inPolicy && indent <= policyIndent) {
            inPolicy = false;
        }

        if (!inPolicy) {
            continue;
        }

        const match = /^allow_implicit_invocation\s*:\s*(true|false)\s*$/.exec(trimmed);
        if (match) {
            return match[1] === "true";
        }
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
    const withFencedCommands = await replaceAsync(
        content,
        FENCED_COMMAND_PATTERN,
        async (_match, indentation: string, command: string) => {
            const output = await runDynamicCommand(
                command.trim(),
                effectiveShell,
                cwd,
                executeCommand,
            );
            return `${indentation}${output}`;
        },
    );

    return replaceAsync(
        withFencedCommands,
        INLINE_COMMAND_PATTERN,
        async (_match, prefix: string, command: string) => {
            const output = await runDynamicCommand(
                command.trim(),
                effectiveShell,
                cwd,
                executeCommand,
            );
            return `${prefix}${output}`;
        },
    );
}

function createPiCommandExecutor(pi: ExtensionAPI): DynamicCommandExecutor {
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

function isKnownSkillPath(commands: readonly SlashCommandInfo[], filePath: string): boolean {
    return commands.some(
        (command) => command.source === "skill" && resolve(command.sourceInfo.path) === filePath,
    );
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
                if (!metadata.userInvocable) {
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
    filterUserInvocableSuggestions,
    parseSkillInvocation,
    parseDynamicShell,
    truncateCommandOutput,
};
