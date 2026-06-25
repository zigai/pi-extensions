import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { getTypedAutocompleteSuggestions } from "../completions.js";
import { openArgumentForm } from "../form/open.js";
import { parseTypedCommandArgs } from "../parser.js";
import { onTypedCommandsChanged } from "../registry.js";
import { isTypedSkillCommand } from "../skills/command.js";
import type { TypedCommandUxOptions } from "../types.js";
import { formatDetailedHelp } from "../usage.js";
import {
    commandInvocationForEditorText,
    helperInvocationForEditorText,
} from "./editor-invocation.js";
import {
    clearSubmittedInvalidEditorText,
    setCurrentHelperPlacement,
    setHelperWidget,
    WIDGET_KEY,
} from "./helper.js";
import { renderTypedSkillInput } from "./skill-input.js";
import { resolveTypedCommandUxOptions } from "./settings.js";
import { completePartialFlagOnTab } from "./tab-completion.js";

async function openEditorCommandForm(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
    const invocation = commandInvocationForEditorText(ctx.ui.getEditorText());
    if (invocation === undefined) {
        return;
    }

    const { command, rawArgs, trailingBody } = invocation;
    const commandCtx = ctx as ExtensionCommandContext;

    if (isTypedSkillCommand(command)) {
        const transformed = await renderTypedSkillInput(
            command,
            rawArgs,
            trailingBody,
            commandCtx,
            "all",
        );
        if (transformed === undefined) {
            return;
        }
        ctx.ui.setEditorText("");
        pi.sendUserMessage(transformed);
        return;
    }

    const parsed = parseTypedCommandArgs(command, rawArgs);
    if (parsed.mode === "help") {
        ctx.ui.notify(formatDetailedHelp(command), "info");
        return;
    }

    const args = await openArgumentForm(command, parsed, "all", commandCtx);
    if (args === undefined) {
        return;
    }

    if (command.target?.kind !== "extension") {
        ctx.ui.notify(
            `Typed command /${command.name} does not have an extension handler.`,
            "error",
        );
        return;
    }

    ctx.ui.setEditorText("");
    await command.target.run(args, commandCtx);
}

function notifyDetachedError(ctx: ExtensionContext, error: unknown): void {
    let message = String(error);
    if (error instanceof Error) {
        message = error.message;
    }
    ctx.ui.notify(message, "error");
}

/** Session-scoped Pi UX bridge for helper widgets, autocomplete, and Tab-to-form behavior. */
export class TypedCommandUxSession {
    private cleanup: Array<() => void> = [];
    private refreshTimer: NodeJS.Timeout | undefined;
    private openingForm = false;
    private options: Required<TypedCommandUxOptions>;

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly configuredOptions: TypedCommandUxOptions,
    ) {
        this.options = resolveTypedCommandUxOptions(configuredOptions);
    }

    start(ctx: ExtensionContext): void {
        this.stop();
        this.options = resolveTypedCommandUxOptions(this.configuredOptions, ctx);
        setCurrentHelperPlacement(this.options.helperPlacement);
        if (!ctx.hasUI) {
            return;
        }
        const refresh = (): void => {
            this.refresh(ctx);
        };

        this.cleanup.push(ctx.ui.onTerminalInput((data) => this.handleTerminalInput(data, ctx)));
        this.cleanup.push(onTypedCommandsChanged(refresh));
        this.addAutocompleteProvider(ctx);
        refresh();
    }

    clearWidget(ctx: ExtensionContext): void {
        this.clearRefreshTimer();
        if (ctx.hasUI) {
            ctx.ui.setWidget(WIDGET_KEY, undefined, {
                placement: this.options.helperPlacement,
            });
        }
    }

    stop(): void {
        this.clearRefreshTimer();
        for (const callback of this.cleanup) {
            callback();
        }
        this.cleanup = [];
        this.openingForm = false;
    }

    private clearRefreshTimer(): void {
        if (this.refreshTimer === undefined) {
            return;
        }
        clearTimeout(this.refreshTimer);
        this.refreshTimer = undefined;
    }

    private refresh(ctx: ExtensionContext): void {
        if (this.openingForm) {
            setHelperWidget(ctx, undefined, this.options.helperPlacement);
            return;
        }
        const helperInvocation = helperInvocationForEditorText(ctx.ui.getEditorText());
        setHelperWidget(ctx, helperInvocation, this.options.helperPlacement);
    }

    private scheduleRefresh(ctx: ExtensionContext): void {
        this.clearRefreshTimer();
        this.refreshTimer = setTimeout(() => {
            this.refresh(ctx);
        }, 0);
    }

    private handleTerminalInput(
        data: string,
        ctx: ExtensionContext,
    ): { consume: true } | undefined {
        if (this.openingForm) {
            setHelperWidget(ctx, undefined, this.options.helperPlacement);
            return undefined;
        }
        if (!matchesKey(data, "tab")) {
            clearSubmittedInvalidEditorText();
            this.scheduleRefresh(ctx);
            return undefined;
        }

        const editorText = ctx.ui.getEditorText();
        const completion = completePartialFlagOnTab(editorText);
        if (completion.handled === true) {
            if ("editorText" in completion && completion.editorText !== undefined) {
                ctx.ui.setEditorText(completion.editorText);
            }
            this.scheduleRefresh(ctx);
            return { consume: true };
        }

        if (commandInvocationForEditorText(editorText) === undefined) {
            this.scheduleRefresh(ctx);
            return undefined;
        }

        this.openingForm = true;
        this.clearWidget(ctx);
        void openEditorCommandForm(this.pi, ctx)
            .catch((error: unknown) => {
                notifyDetachedError(ctx, error);
            })
            .finally(() => {
                this.openingForm = false;
                this.scheduleRefresh(ctx);
            });
        return { consume: true };
    }

    private addAutocompleteProvider(ctx: ExtensionContext): void {
        ctx.ui.addAutocompleteProvider((current) => ({
            async getSuggestions(lines, cursorLine, cursorCol, options) {
                if (
                    commandInvocationForEditorText(
                        (lines[cursorLine] ?? "").slice(0, cursorCol),
                    ) !== undefined
                ) {
                    return null;
                }

                const suggestions = getTypedAutocompleteSuggestions(
                    lines,
                    cursorLine,
                    cursorCol,
                    ctx.cwd,
                    ctx,
                );
                if (suggestions !== undefined) {
                    return suggestions;
                }
                return current.getSuggestions(lines, cursorLine, cursorCol, options);
            },
            applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
                return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
            },
            shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
                return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
            },
        }));
    }
}
