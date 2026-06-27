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
import { setHelperWidget, WIDGET_KEY } from "./helper.js";
import { renderTypedSkillInput } from "./skill-input.js";
import { registerSubmittedInvalidCommandHandler } from "./session-state.js";
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

function thrownValueKind(error: unknown): string {
    if (error instanceof Error) {
        return "Error";
    }
    return typeof error;
}

function notifyDetachedError(ctx: ExtensionContext): void {
    ctx.ui.notify("Typed command form failed.", "error");
}

function reportDetachedError(ctx: ExtensionContext, error: unknown): void {
    try {
        notifyDetachedError(ctx);
    } catch (notifyError) {
        console.error(`pi-typed-commands detached form task failed (${thrownValueKind(error)})`);
        console.error(
            `pi-typed-commands failed to report detached form task error (${thrownValueKind(
                notifyError,
            )})`,
        );
    }
}

/** Session-scoped Pi UX bridge for helper widgets, autocomplete, and Tab-to-form behavior. */
export class TypedCommandUxSession {
    private cleanup: Array<() => void> = [];
    private refreshTimer: NodeJS.Timeout | undefined;
    private openingForm = false;
    private active = false;
    private formRunId = 0;
    private submittedInvalidEditorText: string | undefined;
    private options: Required<TypedCommandUxOptions>;

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly configuredOptions: TypedCommandUxOptions,
    ) {
        this.options = resolveTypedCommandUxOptions(configuredOptions);
    }

    start(ctx: ExtensionContext): void {
        this.stop();
        this.active = true;
        this.options = resolveTypedCommandUxOptions(this.configuredOptions, ctx);
        if (!ctx.hasUI) {
            return;
        }
        const refresh = (): void => {
            this.refresh(ctx);
        };

        this.cleanup.push(ctx.ui.onTerminalInput((data) => this.handleTerminalInput(data, ctx)));
        this.cleanup.push(
            registerSubmittedInvalidCommandHandler(ctx, (editorText) => {
                this.showSubmittedInvalidCommand(ctx, editorText);
            }),
        );
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
        this.active = false;
        this.formRunId += 1;
        this.submittedInvalidEditorText = undefined;
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
        setHelperWidget(ctx, helperInvocation, this.options.helperPlacement, {
            submittedInvalidEditorText: this.submittedInvalidEditorText,
        });
    }

    private showSubmittedInvalidCommand(ctx: ExtensionContext, editorText: string): void {
        this.clearRefreshTimer();
        this.submittedInvalidEditorText = editorText;
        const helperInvocation = helperInvocationForEditorText(editorText);
        setHelperWidget(ctx, helperInvocation, this.options.helperPlacement, {
            submittedInvalidEditorText: editorText,
        });
    }

    private scheduleRefresh(ctx: ExtensionContext): void {
        if (!this.active) {
            return;
        }
        this.clearRefreshTimer();
        this.refreshTimer = setTimeout(() => {
            try {
                if (this.active) {
                    this.refresh(ctx);
                }
            } catch (error) {
                reportDetachedError(ctx, error);
            }
        }, 0);
    }

    private launchOpenEditorCommandForm(ctx: ExtensionContext): void {
        this.openingForm = true;
        const runId = this.formRunId + 1;
        this.formRunId = runId;
        this.clearWidget(ctx);
        void this.runOpenEditorCommandForm(ctx, runId);
    }

    private async runOpenEditorCommandForm(ctx: ExtensionContext, runId: number): Promise<void> {
        try {
            await openEditorCommandForm(this.pi, ctx);
        } catch (error) {
            reportDetachedError(ctx, error);
        }

        try {
            if (this.formRunId !== runId) {
                return;
            }
            this.openingForm = false;
            this.scheduleRefresh(ctx);
        } catch (error) {
            reportDetachedError(ctx, error);
        }
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
            this.submittedInvalidEditorText = undefined;
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

        this.launchOpenEditorCommandForm(ctx);
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
