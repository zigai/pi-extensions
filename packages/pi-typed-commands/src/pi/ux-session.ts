import {
    CustomEditor,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { openArgumentForm } from "../form/open.js";
import {
    parseTypedCommandArgs,
    parseTypedCommandInvocation,
    serializeTypedCommandArgs,
} from "../parser.js";
import type { TypedCommandRegistry } from "../registry.js";
import { isFormOnlyArgument, validateArgumentValue } from "../schema.js";
import { isTypedSkillCommand } from "../skills/command.js";
import type { ArgumentValue, TypedCommandUxOptions } from "../types.js";
import { createPiCompletionCapabilities, getTypedAutocompleteSuggestions } from "./completions.js";
import {
    commandDisplayName,
    commandInvocationForEditorText,
    helperInvocationForEditorText,
    type EditorTypedCommandInvocation,
} from "./editor-invocation.js";
import { notifyDetailedHelp } from "./help.js";
import { resolveTypedCommandFormTitle } from "./form-title.js";
import { resolveGhostText, withGhostText } from "./ghost-text.js";
import { setHelperWidget, WIDGET_KEY } from "./helper.js";
import { renderTypedSkillInput } from "./skill-input.js";
import {
    registerSubmittedInvalidCommandHandler,
    stageExpandedFormArguments,
} from "./session-state.js";
import {
    loadTypedCommandPresets,
    recordTypedCommandRecentValues,
    saveTypedCommandPreset,
} from "./presets.js";
import {
    resolvePiTypedCommandsConfigSnapshot,
    resolveTypedCommandUxOptions,
    type ResolvedPiTypedCommandsConfigSnapshot,
    type ResolvedTypedCommandUxOptions,
} from "./settings.js";
import { completeTypedCommandOnTab } from "./tab-completion.js";

type PiEditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

type EditorUxInstallation = {
    readonly ctx: ExtensionContext;
    readonly previous: PiEditorFactory | undefined;
    readonly installed: PiEditorFactory;
    readonly getActiveEditor: () => ReturnType<PiEditorFactory> | undefined;
};

async function openEditorCommandForm(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    options: ResolvedTypedCommandUxOptions,
    registry: TypedCommandRegistry,
    signal: AbortSignal,
    isCurrent: () => boolean,
    submitEditorInput: (data: string) => boolean,
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
            registry,
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

    const routed = parseTypedCommandInvocation(command, rawArgs);
    let selectedCommand = command;
    let selectedSubcommand = routed.route.subcommand;
    let selectedRawArgs = routed.route.rawArgs;
    if (routed.route.status === "subcommand" && selectedSubcommand !== undefined) {
        selectedCommand = command.subcommands?.[selectedSubcommand] ?? command;
    } else if (
        routed.route.status === "missing" ||
        routed.route.status === "unknown" ||
        (rawArgs.trim().length === 0 && command.subcommands !== undefined)
    ) {
        const rootOption = "(root command)";
        const options = Object.keys(command.subcommands ?? {});
        if (command.hasRootHandler === true) {
            options.unshift(rootOption);
        }

        const selected = await ctx.ui.select("Select subcommand", options, { signal });
        if (selected === undefined || !isCurrent()) {
            return;
        }

        if (selected === rootOption) {
            selectedSubcommand = undefined;
            selectedCommand = command;
            selectedRawArgs = rawArgs;
        } else {
            selectedSubcommand = selected;
            selectedCommand = command.subcommands?.[selected] ?? command;
            selectedRawArgs = "";
        }
    }

    let parsed = parseTypedCommandArgs(selectedCommand, selectedRawArgs);
    if (selectedCommand.formPresets === true) {
        const collection = loadTypedCommandPresets(ctx, selectedCommand);
        if (collection === undefined) {
            ctx.ui.notify("Typed command presets could not be read.", "warning");
        } else {
            const currentOption = "Current editor values";
            const recentOption = "Recent values";
            const presetPrefix = "Preset: ";
            const presetOptions = Object.keys(collection.presets).map(
                (name) => `${presetPrefix}${name}`,
            );
            const choices = [currentOption];
            if (collection.recent !== undefined) {
                choices.push(recentOption);
            }

            choices.push(...presetOptions);

            if (choices.length > 1) {
                const selectedPreset = await ctx.ui.select("Load form values", choices, {
                    signal,
                });
                if (selectedPreset === undefined || !isCurrent()) {
                    return;
                }

                let presetValues: Readonly<Record<string, ArgumentValue>> | undefined;
                if (selectedPreset === recentOption) {
                    presetValues = collection.recent;
                } else if (selectedPreset.startsWith(presetPrefix)) {
                    presetValues = collection.presets[selectedPreset.slice(presetPrefix.length)];
                }

                if (presetValues !== undefined) {
                    const mergedValues = { ...presetValues };
                    for (const [name, value] of Object.entries(parsed.values)) {
                        if (parsed.sources?.get(name) !== "default") {
                            mergedValues[name] = value;
                        } else {
                            mergedValues[name] ??= value;
                        }
                    }

                    const presetNames = Object.keys(presetValues);
                    const provided = new Set([...parsed.provided, ...presetNames]);
                    const sources = new Map(parsed.sources ?? []);
                    for (const name of presetNames) {
                        sources.set(name, "explicit");
                    }

                    const issues = parsed.issues.filter((issue) => {
                        if (issue.name === undefined) {
                            return true;
                        }

                        const definition = selectedCommand.args[issue.name];
                        if (definition === undefined) {
                            return true;
                        }

                        return !validateArgumentValue(
                            issue.name,
                            definition,
                            mergedValues[issue.name],
                        ).ok;
                    });

                    parsed = { ...parsed, values: mergedValues, provided, sources, issues };
                }
            }
        }
    }

    if (parsed.mode === "help") {
        if (isCurrent()) notifyDetailedHelp(ctx, selectedCommand, options.appearance);
        return;
    }

    let submitInput: string | undefined;
    const args = await openArgumentForm(selectedCommand, parsed, "all", ctx, {
        appearance: options.appearance,
        signal,
        title: resolveTypedCommandFormTitle(selectedCommand, ctx),
        completionCapabilities: createPiCompletionCapabilities(ctx.cwd, registry, signal),
        onTuiSubmitInput(data) {
            submitInput = data;
        },
    });
    if (args === undefined || !isCurrent()) {
        return;
    }

    if (selectedCommand.formPresets === true) {
        if (!recordTypedCommandRecentValues(ctx, selectedCommand, args)) {
            ctx.ui.notify("Typed command recent values could not be saved.", "warning");
        }

        const action = await ctx.ui.select(
            "Form action",
            ["Apply to editor", "Apply and save preset"],
            { signal },
        );
        if (action === undefined || !isCurrent()) {
            return;
        }

        if (action === "Apply and save preset") {
            const presetName = await ctx.ui.input("Preset name", "", { signal });
            if (presetName === undefined || !isCurrent()) {
                return;
            }

            if (!saveTypedCommandPreset(ctx, selectedCommand, presetName, args)) {
                ctx.ui.notify("Typed command preset could not be saved.", "warning");
            }
        }
    }

    if (selectedCommand.target?.kind !== "extension") {
        if (isCurrent())
            ctx.ui.notify(
                `Typed command /${command.name} does not have an extension handler.`,
                "error",
            );

        return;
    }

    const serialized = serializeTypedCommandArgs(selectedCommand, args);
    const invocationName = command.invocationName ?? command.name;
    let editorText = `/${invocationName}`;
    if (selectedSubcommand !== undefined) {
        editorText += ` ${selectedSubcommand}`;
    }

    if (serialized.length > 0) {
        editorText += ` ${serialized}`;
    }

    const hasStagedArguments = Object.values(selectedCommand.args).some(
        (definition) =>
            isFormOnlyArgument(definition) ||
            (definition.type === "string" && definition.sensitive === true),
    );
    if (hasStagedArguments && !stageExpandedFormArguments(ctx, invocationName, editorText, args)) {
        ctx.ui.notify("Typed command form values could not be staged.", "error");
        return;
    }

    ctx.ui.setEditorText(editorText);

    if (submitInput !== undefined) {
        submitEditorInput(submitInput);
    }
}

function thrownValueKind(error: unknown): "Error" | "non-Error" {
    if (error instanceof Error) {
        return "Error";
    }

    return "non-Error";
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
    private completionRequestId = 0;
    private activeTypedCompletionEditorText: string | undefined;
    private helperWidgetSignature: string | undefined;
    private editorUxInstallation: EditorUxInstallation | undefined;
    private configSnapshot: ResolvedPiTypedCommandsConfigSnapshot | undefined;
    private options: ResolvedTypedCommandUxOptions;

    constructor(
        private readonly pi: ExtensionAPI,
        private configuredOptions: TypedCommandUxOptions,
        private readonly registry: TypedCommandRegistry,
    ) {
        this.options = resolveTypedCommandUxOptions(configuredOptions);
    }

    /** Merge explicit composition options without installing a second Pi UX bridge. */
    mergeConfiguredOptions(options: TypedCommandUxOptions): void {
        this.configuredOptions = { ...this.configuredOptions, ...options };
        this.options = resolveTypedCommandUxOptions(this.configuredOptions, this.configSnapshot);
    }

    async start(ctx: ExtensionContext): Promise<void> {
        await this.stop();
        this.helperWidgetSignature = undefined;
        this.active = true;
        this.configSnapshot = resolvePiTypedCommandsConfigSnapshot({
            cwd: ctx.cwd,
            projectTrusted: ctx.isProjectTrusted(),
        });
        this.options = resolveTypedCommandUxOptions(this.configuredOptions, this.configSnapshot);

        if (!ctx.hasUI) {
            return;
        }

        for (const diagnostic of this.options.diagnostics) {
            ctx.ui.notify(diagnostic.message, "warning");
        }

        const refresh = (): void => {
            this.syncEditorUx(ctx);
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
        this.uninstallEditorUx();

        for (const callback of this.cleanup) {
            callback();
        }

        this.cleanup = [];
        this.openingForm = false;
        this.active = false;
        this.formRunId += 1;
        this.submittedInvalidEditorText = undefined;
        this.armedDoubleTabEditorText = undefined;
        this.completionRequestId += 1;
        this.activeTypedCompletionEditorText = undefined;

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

    private needsEditorUx(): boolean {
        return this.registry.list().some((command) => {
            if (
                command.ghostText !== undefined ||
                (command.target?.kind === "extension" && Object.keys(command.args).length > 0)
            ) {
                return true;
            }

            return Object.values(command.subcommands ?? {}).some((subcommand) => {
                return (
                    subcommand.ghostText !== undefined ||
                    (subcommand.target?.kind === "extension" &&
                        Object.keys(subcommand.args).length > 0)
                );
            });
        });
    }

    private syncEditorUx(ctx: ExtensionContext): void {
        if (ctx.mode !== "tui" || !this.needsEditorUx()) {
            this.uninstallEditorUx();
            return;
        }

        if (this.editorUxInstallation !== undefined) {
            return;
        }

        const previous = ctx.ui.getEditorComponent();
        let activeEditor: ReturnType<PiEditorFactory> | undefined;
        const installed: PiEditorFactory = (tui, theme, keybindings) => {
            const base =
                previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
            const decorated = withGhostText(
                base,
                () => resolveGhostText(base.getText(), this.registry, ctx)?.text,
                (text) => ctx.ui.theme.fg("dim", text),
            );

            activeEditor = decorated;
            return decorated;
        };

        this.editorUxInstallation = {
            ctx,
            previous,
            installed,
            getActiveEditor: () => activeEditor,
        };
        ctx.ui.setEditorComponent(installed);
    }

    private uninstallEditorUx(): void {
        const installation = this.editorUxInstallation;
        if (installation === undefined) {
            return;
        }

        this.editorUxInstallation = undefined;

        if (installation.ctx.ui.getEditorComponent() === installation.installed) {
            installation.ctx.ui.setEditorComponent(installation.previous);
        }
    }

    private submitEditorInput(ctx: ExtensionContext, data: string): boolean {
        const installation = this.editorUxInstallation;
        if (
            installation === undefined ||
            installation.ctx !== ctx ||
            ctx.ui.getEditorComponent() !== installation.installed
        ) {
            return false;
        }

        const editor = installation.getActiveEditor();
        if (editor === undefined) {
            return false;
        }

        editor.handleInput(data);

        return true;
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
                (data) => this.submitEditorInput(ctx, data),
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

        if (!getKeybindings().matches(data, "tui.input.tab")) {
            this.submittedInvalidEditorText = undefined;
            this.armedDoubleTabEditorText = undefined;
            this.activeTypedCompletionEditorText = undefined;
            this.scheduleRefresh(ctx);

            return undefined;
        }

        const editorText = ctx.ui.getEditorText();
        const invocation = commandInvocationForEditorText(editorText, this.registry);
        if (
            this.activeTypedCompletionEditorText === editorText &&
            invocation !== undefined &&
            invocation.rawArgs.length > 0
        ) {
            this.activeTypedCompletionEditorText = undefined;
            this.scheduleRefresh(ctx);
            return undefined;
        }

        const completion = completeTypedCommandOnTab(editorText, this.registry);
        if (completion.handled) {
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

        ctx.ui.addAutocompleteProvider((current) => {
            const provider: AutocompleteProvider = {
                getSuggestions: async (lines, cursorLine, cursorCol, options) => {
                    const requestId = this.completionRequestId + 1;
                    this.completionRequestId = requestId;

                    let completionSignal = options.signal;
                    if (ctx.signal !== undefined) {
                        completionSignal = AbortSignal.any([ctx.signal, options.signal]);
                    }

                    const suggestions = await getTypedAutocompleteSuggestions(
                        lines,
                        cursorLine,
                        cursorCol,
                        createPiCompletionCapabilities(ctx.cwd, registry, completionSignal),
                    );
                    if (requestId === this.completionRequestId) {
                        this.activeTypedCompletionEditorText = undefined;
                        if (suggestions !== undefined && suggestions.items.length > 0) {
                            this.activeTypedCompletionEditorText = lines.join("\n");
                        }
                    }

                    if (suggestions !== undefined) {
                        return suggestions;
                    }

                    return current.getSuggestions(lines, cursorLine, cursorCol, options);
                },
                applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
                    return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
                },
                shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
                    return (
                        current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true
                    );
                },
            };
            if (current.triggerCharacters !== undefined) {
                provider.triggerCharacters = [...current.triggerCharacters];
            }

            return provider;
        });
    }
}
