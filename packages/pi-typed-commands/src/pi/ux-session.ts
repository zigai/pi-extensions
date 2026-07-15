import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { openArgumentForm } from "../form/open.js";
import { parseTypedCommandArgs, serializeTypedCommandArgs } from "../parser.js";
import type { TypedCommandRegistry } from "../registry.js";
import { isFormOnlyArgument } from "../schema.js";
import { isTypedSkillCommand } from "../skills/command.js";
import type { TypedCommandUxOptions } from "../types.js";
import {
    createPiCompletionCapabilities,
    getTypedAutocompleteSuggestions,
} from "./completions.js";
import {
    commandDisplayName,
    commandInvocationForEditorText,
    helperInvocationForEditorText,
    type EditorTypedCommandInvocation,
} from "./editor-invocation.js";
import { notifyDetailedHelp } from "./help.js";
import { resolveTypedCommandFormTitle } from "./form-title.js";
import { setHelperWidget, WIDGET_KEY } from "./helper.js";
import { renderTypedSkillInput } from "./skill-input.js";
import {
    registerSubmittedInvalidCommandHandler,
    stageExpandedFormArguments,
} from "./session-state.js";
import {
    resolvePiTypedCommandsConfigSnapshot,
    resolveTypedCommandUxOptions,
    type ResolvedTypedCommandUxOptions,
} from "./settings.js";
import { completePartialFlagOnTab } from "./tab-completion.js";

async function openEditorCommandForm(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    options: ResolvedTypedCommandUxOptions,
    registry: TypedCommandRegistry,
    signal: AbortSignal,
    isCurrent: () => boolean,
): Promise<void> {
    const invocation = commandInvocationForEditorText(ctx.ui.getEditorText(), registry);
    if (invocation === undefined) {
        return;
    }

    const { command, rawArgs, trailingBody } = invocation;

    if (isTypedSkillCommand(command)) {
        const transformed = await renderTypedSkillInput(
            command,
            rawArgs,
            trailingBody,
            ctx,
            "all",
            options.appearance,
            signal,
        );
        if (transformed === undefined || !isCurrent()) {
            return;
        }
        ctx.ui.setEditorText("");
        if (!isCurrent()) {
            return;
        }
        pi.sendUserMessage(transformed);
        return;
    }

    const parsed = parseTypedCommandArgs(command, rawArgs);
    if (parsed.mode === "help") {
        if (isCurrent()) notifyDetailedHelp(ctx, command, options.appearance);
        return;
    }

    const args = await openArgumentForm(command, parsed, "all", ctx, {
        appearance: options.appearance,
        signal,
        title: resolveTypedCommandFormTitle(command, ctx),
    });
    if (args === undefined || !isCurrent()) {
        return;
    }

    if (command.target?.kind !== "extension") {
        if (isCurrent()) ctx.ui.notify(
            `Typed command /${command.name} does not have an extension handler.`,
            "error",
        );
        return;
    }

    const serialized = serializeTypedCommandArgs(command, args);
    const invocationName = command.invocationName ?? command.name;
    let editorText = `/${invocationName}`;
    if (serialized.length > 0) {
        editorText += ` ${serialized}`;
    }
    const hasFormOnlyArguments = Object.values(command.args).some(isFormOnlyArgument);
    if (
        hasFormOnlyArguments &&
        !stageExpandedFormArguments(ctx, invocationName, editorText, args)
    ) {
        ctx.ui.notify("Typed command form values could not be staged.", "error");
        return;
    }
    ctx.ui.setEditorText(editorText);
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
        console.error(`pi-typed-args detached form task failed (${thrownValueKind(error)})`);
        console.error(
            `pi-typed-args failed to report detached form task error (${thrownValueKind(
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
    private formTask:
        | { readonly controller: AbortController; readonly completion: Promise<void> }
        | undefined;
    private submittedInvalidEditorText: string | undefined;
    private armedDoubleTabEditorText: string | undefined;
    private helperWidgetSignature: string | undefined;
    private options: ResolvedTypedCommandUxOptions;

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly configuredOptions: TypedCommandUxOptions,
        private readonly registry: TypedCommandRegistry,
    ) {
        this.options = resolveTypedCommandUxOptions(configuredOptions);
    }

    async start(ctx: ExtensionContext): Promise<void> {
        await this.stop();
        this.helperWidgetSignature = undefined;
        this.active = true;
        const snapshot = resolvePiTypedCommandsConfigSnapshot({
            cwd: ctx.cwd,
            projectTrusted: ctx.isProjectTrusted(),
        });
        this.options = resolveTypedCommandUxOptions(this.configuredOptions, snapshot);
        if (!ctx.hasUI) {
            return;
        }
        for (const diagnostic of this.options.diagnostics) {
            ctx.ui.notify(diagnostic.message, "warning");
        }
        const refresh = (): void => {
            this.refresh(ctx);
        };

        this.cleanup.push(ctx.ui.onTerminalInput((data) => this.handleTerminalInput(data, ctx)));
        this.cleanup.push(
            registerSubmittedInvalidCommandHandler(ctx, this.options, (editorText) => {
                this.showSubmittedInvalidCommand(ctx, editorText);
            }),
        );
        this.cleanup.push(this.registry.onChanged(refresh));
        this.addAutocompleteProvider(ctx);
        refresh();
    }

    clearWidget(ctx: ExtensionContext): void {
        this.clearRefreshTimer();
        this.clearHelperWidget(ctx);
    }

    async stop(): Promise<void> {
        this.clearRefreshTimer();
        for (const callback of this.cleanup) {
            callback();
        }
        this.cleanup = [];
        this.openingForm = false;
        this.active = false;
        this.formRunId += 1;
        this.submittedInvalidEditorText = undefined;
        this.armedDoubleTabEditorText = undefined;
        const task = this.formTask;
        this.formTask = undefined;
        if (task !== undefined) {
            task.controller.abort();
            await task.completion;
        }
    }

    /** Deterministically wait for the currently owned form task, if one exists. */
    async waitForFormCompletion(): Promise<void> {
        await this.formTask?.completion;
    }

    /** Return the one settings snapshot resolved for the active session. */
    get resolvedOptions(): ResolvedTypedCommandUxOptions {
        return this.options;
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
            this.clearHelperWidget(ctx);
            return;
        }
        const helperInvocation = helperInvocationForEditorText(
            ctx.ui.getEditorText(),
            this.registry,
        );
        this.syncHelperWidget(ctx, helperInvocation, {
            submittedInvalidEditorText: this.submittedInvalidEditorText,
        });
    }

    private showSubmittedInvalidCommand(ctx: ExtensionContext, editorText: string): void {
        this.clearRefreshTimer();
        this.submittedInvalidEditorText = editorText;
        const helperInvocation = helperInvocationForEditorText(editorText, this.registry);
        this.syncHelperWidget(ctx, helperInvocation, {
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

    private helperSignature(
        invocation: EditorTypedCommandInvocation,
        state: { submittedInvalidEditorText?: string | undefined },
    ): string {
        return JSON.stringify([
            this.options.helperPlacement,
            commandDisplayName(invocation.command),
            invocation.rawArgs,
            invocation.trailingBody,
            state.submittedInvalidEditorText ?? null,
        ]);
    }

    private clearHelperWidget(ctx: ExtensionContext): void {
        if (!ctx.hasUI || this.helperWidgetSignature === undefined) {
            return;
        }
        ctx.ui.setWidget(WIDGET_KEY, undefined, {
            placement: this.options.helperPlacement,
        });
        this.helperWidgetSignature = undefined;
    }

    private syncHelperWidget(
        ctx: ExtensionContext,
        invocation: EditorTypedCommandInvocation | undefined,
        state: { submittedInvalidEditorText?: string | undefined } = {},
    ): void {
        if (invocation === undefined) {
            this.clearHelperWidget(ctx);
            return;
        }
        const signature = this.helperSignature(invocation, state);
        if (signature === this.helperWidgetSignature) {
            return;
        }
        setHelperWidget(
            ctx,
            invocation,
            this.options.helperPlacement,
            state,
            this.options.appearance.inlineHelp,
        );
        this.helperWidgetSignature = signature;
    }

    private launchOpenEditorCommandForm(ctx: ExtensionContext): void {
        this.formTask?.controller.abort();
        this.openingForm = true;
        const runId = this.formRunId + 1;
        this.formRunId = runId;
        this.clearWidget(ctx);
        const controller = new AbortController();
        const completion = this.runOpenEditorCommandForm(ctx, runId, controller);
        this.formTask = { controller, completion };
    }

    private async runOpenEditorCommandForm(
        ctx: ExtensionContext,
        runId: number,
        controller: AbortController,
    ): Promise<void> {
        const isCurrent = (): boolean =>
            this.active && this.formRunId === runId && !controller.signal.aborted;
        try {
            await openEditorCommandForm(
                this.pi,
                ctx,
                this.options,
                this.registry,
                controller.signal,
                isCurrent,
            );
        } catch (error) {
            if (isCurrent()) reportDetachedError(ctx, error);
        }

        try {
            if (!isCurrent()) {
                return;
            }
            this.openingForm = false;
            if (this.formTask?.controller === controller) {
                this.formTask = undefined;
            }
            this.scheduleRefresh(ctx);
        } catch (error) {
            if (isCurrent()) reportDetachedError(ctx, error);
        }
    }

    private handleTerminalInput(
        data: string,
        ctx: ExtensionContext,
    ): { consume: true } | undefined {
        if (this.openingForm) {
            this.clearHelperWidget(ctx);
            return undefined;
        }
        if (!matchesKey(data, "tab")) {
            this.submittedInvalidEditorText = undefined;
            this.armedDoubleTabEditorText = undefined;
            this.scheduleRefresh(ctx);
            return undefined;
        }

        const editorText = ctx.ui.getEditorText();
        const completion = completePartialFlagOnTab(editorText, this.registry);
        if (completion.handled === true) {
            this.armedDoubleTabEditorText = undefined;
            if ("editorText" in completion && completion.editorText !== undefined) {
                ctx.ui.setEditorText(completion.editorText);
            }
            this.scheduleRefresh(ctx);
            return { consume: true };
        }

        if (commandInvocationForEditorText(editorText, this.registry) === undefined) {
            this.armedDoubleTabEditorText = undefined;
            this.scheduleRefresh(ctx);
            return undefined;
        }

        if (this.options.formTrigger === "double-tab") {
            if (this.armedDoubleTabEditorText !== editorText) {
                this.armedDoubleTabEditorText = editorText;
                this.scheduleRefresh(ctx);
                return { consume: true };
            }
            this.armedDoubleTabEditorText = undefined;
        }

        this.launchOpenEditorCommandForm(ctx);
        return { consume: true };
    }

    private addAutocompleteProvider(ctx: ExtensionContext): void {
        const registry = this.registry;
        ctx.ui.addAutocompleteProvider((current) => ({
            async getSuggestions(lines, cursorLine, cursorCol, options) {
                if (
                    commandInvocationForEditorText(
                        (lines[cursorLine] ?? "").slice(0, cursorCol),
                        registry,
                    ) !== undefined
                ) {
                    return null;
                }

                const suggestions = await getTypedAutocompleteSuggestions(
                    lines,
                    cursorLine,
                    cursorCol,
                    createPiCompletionCapabilities(ctx.cwd, registry, ctx.signal),
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
