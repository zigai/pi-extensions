import type {
    ExtensionAPI,
    ExtensionContext,
    SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import {
    cloneModesFile,
    CUSTOM_MODE_NAME,
    ensureDefaultModeEntries,
    findModeForModel,
    modeSpec,
    orderedModeNames,
    shouldApplyDefaultModel,
    type DefaultModelSpec,
    type ModesFile,
    type ModeSpec,
} from "./modes.ts";
import { getMtimeMs, ModesStore } from "./modes-store.ts";
import type { SettingsReadContext } from "./settings.ts";

type ModeControllerPi = Pick<ExtensionAPI, "getThinkingLevel" | "setThinkingLevel" | "setModel">;

export type ModeRuntime = {
    filePath: string;
    fileMtimeMs: number | null;
    baseline: ModesFile | null;
    data: ModesFile;
    lastRealMode: string;
    currentMode: string;
    applying: boolean;
};

function errorMessage(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    return String(cause);
}

export class ModeController {
    private readonly runtime: ModeRuntime = {
        filePath: "",
        fileMtimeMs: null,
        baseline: null,
        data: { version: 1, currentMode: "default", modes: {} },
        lastRealMode: "default",
        currentMode: "default",
        applying: false,
    };

    private requestEditorRender: (() => void) | undefined;
    private useThinkingBorderColors = false;
    private showThinkingLevelStatus = false;
    private customOverlay: ModeSpec | null = null;
    private lastObservedModel: Pick<ModeSpec, "provider" | "modelId"> = {};

    constructor(
        private readonly pi: ModeControllerPi,
        private readonly store: ModesStore = new ModesStore(),
    ) {}

    get currentMode(): string {
        return this.runtime.currentMode;
    }

    get modes(): Readonly<ModesFile> {
        return this.runtime.data;
    }

    setEditorRenderRequest(requestRender?: () => void): void {
        this.requestEditorRender = requestRender;
    }

    setUseThinkingBorderColors(enabled: boolean): void {
        this.useThinkingBorderColors = enabled;
    }

    get thinkingBorderColorsEnabled(): boolean {
        return this.useThinkingBorderColors;
    }

    setShowThinkingLevelStatus(enabled: boolean): void {
        this.showThinkingLevelStatus = enabled;
    }

    get thinkingLevelStatusEnabled(): boolean {
        return this.showThinkingLevelStatus;
    }

    requestRender(): void {
        this.requestEditorRender?.();
    }

    getSettingsContext(
        ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
    ): SettingsReadContext {
        return { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() };
    }

    getModeBorderColor(
        ctx: ExtensionContext,
        mode: string,
        fallbackBorderColor?: (text: string) => string,
    ): (text: string) => string {
        const theme = ctx.ui.theme;
        const spec = modeSpec(this.runtime.data.modes, mode);
        if (spec?.color !== undefined && spec.color.length > 0) {
            const color = spec.color;

            try {
                theme.getFgAnsi(color);

                return (text: string) => theme.fg(color, text);
            } catch {
                // Fall through to the configured fallback border color.
            }
        }

        if (!this.useThinkingBorderColors) {
            return fallbackBorderColor ?? ((text: string) => theme.fg("borderMuted", text));
        }

        return theme.getThinkingBorderColor(this.pi.getThinkingLevel());
    }

    async ensure(ctx: ExtensionContext): Promise<void> {
        const fallbackMode = this.getFallbackModeSpec(ctx);
        const filePath = await this.store.resolvePath({
            cwd: ctx.cwd,
            projectTrusted: ctx.isProjectTrusted(),
        });
        const mtimeMs = await getMtimeMs(filePath);
        const filePathChanged = this.runtime.filePath !== filePath;

        if (filePathChanged || this.runtime.fileMtimeMs !== mtimeMs) {
            this.runtime.filePath = filePath;
            this.runtime.fileMtimeMs = mtimeMs;

            const loaded = await this.store.load(filePath, fallbackMode);
            ensureDefaultModeEntries(loaded, fallbackMode);
            this.runtime.data = loaded;
            this.runtime.baseline = cloneModesFile(loaded);
            if (filePathChanged && this.runtime.currentMode !== CUSTOM_MODE_NAME) {
                this.runtime.currentMode = loaded.currentMode;
                this.runtime.lastRealMode = loaded.currentMode;
            }
        }

        if (this.runtime.currentMode !== CUSTOM_MODE_NAME) {
            if (
                this.runtime.currentMode.length === 0 ||
                !(this.runtime.currentMode in this.runtime.data.modes)
            ) {
                this.runtime.currentMode = this.runtime.data.currentMode;
            }

            if (
                this.runtime.lastRealMode.length === 0 ||
                !(this.runtime.lastRealMode in this.runtime.data.modes)
            ) {
                this.runtime.lastRealMode = this.runtime.currentMode;
            }
        }
    }

    async persist(ctx: ExtensionContext): Promise<void> {
        if (this.runtime.filePath.length === 0) return;

        this.runtime.baseline ??= cloneModesFile(this.runtime.data);

        try {
            const saved = await this.store.saveChanges(
                this.runtime.filePath,
                this.runtime.baseline,
                this.runtime.data,
                this.getFallbackModeSpec(ctx),
            );
            if (saved !== null) {
                this.runtime.data = saved.data;
                this.runtime.baseline = cloneModesFile(saved.data);
                this.runtime.fileMtimeMs = saved.mtimeMs;
            }
        } catch (cause: unknown) {
            if (ctx.hasUI) {
                ctx.ui.notify(`Mode settings were not saved: ${errorMessage(cause)}`, "error");
            }

            throw cause;
        }
    }

    getCurrentSelection(): ModeSpec {
        return {
            provider: this.lastObservedModel.provider,
            modelId: this.lastObservedModel.modelId,
            thinkingLevel: this.pi.getThinkingLevel(),
        };
    }

    getOverlaySelection(): ModeSpec {
        return this.customOverlay ?? this.getCurrentSelection();
    }

    async applyMode(ctx: ExtensionContext, mode: string): Promise<void> {
        await this.ensure(ctx);

        if (mode === CUSTOM_MODE_NAME) {
            this.runtime.currentMode = CUSTOM_MODE_NAME;
            this.customOverlay = this.getCurrentSelection();

            if (ctx.hasUI) this.requestEditorRender?.();
            return;
        }

        const spec = modeSpec(this.runtime.data.modes, mode);
        if (spec === undefined) {
            if (ctx.hasUI) ctx.ui.notify(`Unknown mode: ${mode}`, "warning");
            return;
        }

        this.runtime.currentMode = mode;
        this.runtime.lastRealMode = mode;
        this.customOverlay = null;
        this.runtime.applying = true;

        let modelApplied = true;

        try {
            if (
                spec.provider !== undefined &&
                spec.provider.length > 0 &&
                spec.modelId !== undefined &&
                spec.modelId.length > 0
            ) {
                const model = ctx.modelRegistry.find(spec.provider, spec.modelId);
                if (model === undefined) {
                    modelApplied = false;

                    if (ctx.hasUI) {
                        ctx.ui.notify(
                            `Mode "${mode}" references unknown model ${spec.provider}/${spec.modelId}`,
                            "warning",
                        );
                    }
                } else {
                    modelApplied = await this.pi.setModel(model);
                    if (!modelApplied && ctx.hasUI) {
                        ctx.ui.notify(
                            `No API key available for ${spec.provider}/${spec.modelId}`,
                            "warning",
                        );
                    }
                }
            }

            if (spec.thinkingLevel !== undefined) this.pi.setThinkingLevel(spec.thinkingLevel);
        } finally {
            this.runtime.applying = false;
        }

        if (!modelApplied) {
            this.runtime.currentMode = CUSTOM_MODE_NAME;
            this.customOverlay = this.getCurrentSelection();
        }

        if (ctx.hasUI) this.requestEditorRender?.();
    }

    async storeSelection(ctx: ExtensionContext, mode: string, selection: ModeSpec): Promise<void> {
        if (mode === CUSTOM_MODE_NAME) return;

        await this.ensure(ctx);

        const next: ModeSpec = { ...this.runtime.data.modes[mode] };
        if (
            selection.provider !== undefined &&
            selection.provider.length > 0 &&
            selection.modelId !== undefined &&
            selection.modelId.length > 0
        ) {
            next.provider = selection.provider;
            next.modelId = selection.modelId;
        }

        if (selection.thinkingLevel !== undefined) next.thinkingLevel = selection.thinkingLevel;
        this.runtime.data.modes[mode] = next;
        await this.persist(ctx);
    }

    async setDefaultModel(ctx: ExtensionContext, spec: DefaultModelSpec): Promise<void> {
        this.runtime.data.defaultModel = spec;
        await this.persist(ctx);
    }

    async renameMode(ctx: ExtensionContext, oldName: string, newName: string): Promise<void> {
        const renamed: Record<string, ModeSpec> = {};
        for (const [name, spec] of Object.entries(this.runtime.data.modes)) {
            let targetName = name;
            if (name === oldName) targetName = newName;
            renamed[targetName] = spec;
        }

        this.runtime.data.modes = renamed;
        await this.persist(ctx);

        if (this.runtime.currentMode === oldName) this.runtime.currentMode = newName;
        if (this.runtime.lastRealMode === oldName) this.runtime.lastRealMode = newName;
        this.requestEditorRender?.();
    }

    async updateMode(ctx: ExtensionContext, name: string, spec: ModeSpec): Promise<void> {
        this.runtime.data.modes[name] = spec;
        await this.persist(ctx);
    }

    async addMode(ctx: ExtensionContext, name: string): Promise<void> {
        const selection = this.getOverlaySelection();
        this.runtime.data.modes[name] = { ...selection };
        await this.persist(ctx);
    }

    async deleteMode(ctx: ExtensionContext, name: string): Promise<void> {
        delete this.runtime.data.modes[name];
        await this.persist(ctx);

        if (this.runtime.currentMode === name) {
            this.runtime.currentMode = CUSTOM_MODE_NAME;
            this.customOverlay = this.getCurrentSelection();
        }

        if (this.runtime.lastRealMode === name) {
            this.runtime.lastRealMode = orderedModeNames(this.runtime.data.modes)[0] ?? "";
        }

        this.requestEditorRender?.();
    }

    async cycle(ctx: ExtensionContext, direction: 1 | -1 = 1): Promise<void> {
        if (!ctx.hasUI) return;

        await this.ensure(ctx);

        const names = orderedModeNames(this.runtime.data.modes);
        if (names.length === 0) return;

        let baseMode =
            findModeForModel(this.runtime.data.modes, ctx.model?.provider, ctx.model?.id) ??
            this.runtime.currentMode;
        if (this.runtime.currentMode === CUSTOM_MODE_NAME && baseMode === CUSTOM_MODE_NAME) {
            baseMode = this.runtime.lastRealMode;
        }

        const fallbackMode = names.at(0);
        if (fallbackMode === undefined) return;

        const index = Math.max(0, names.indexOf(baseMode));
        await this.applyMode(
            ctx,
            names[(index + direction + names.length) % names.length] ?? fallbackMode,
        );
    }

    async handleSessionActivated(ctx: ExtensionContext, event: SessionStartEvent): Promise<void> {
        await this.ensure(ctx);

        if (shouldApplyDefaultModel(event, ctx.sessionManager.getEntries())) {
            await this.applyConfiguredDefaultModel(ctx);
        }

        this.lastObservedModel = { provider: ctx.model?.provider, modelId: ctx.model?.id };
        this.customOverlay = null;

        const inferred = findModeForModel(
            this.runtime.data.modes,
            ctx.model?.provider,
            ctx.model?.id,
        );
        if (inferred !== null && inferred.length > 0) {
            this.runtime.currentMode = inferred;
            this.runtime.lastRealMode = inferred;
        } else {
            this.runtime.currentMode = CUSTOM_MODE_NAME;
            this.customOverlay = this.getCurrentSelection();
        }

        if (ctx.hasUI) this.requestEditorRender?.();
    }

    async handleModelSelect(
        ctx: ExtensionContext,
        event: { readonly model: { readonly provider: string; readonly id: string } },
    ): Promise<void> {
        this.lastObservedModel = { provider: event.model.provider, modelId: event.model.id };
        if (this.runtime.applying) return;

        await this.ensure(ctx);

        if (this.runtime.currentMode !== CUSTOM_MODE_NAME) {
            this.runtime.lastRealMode = this.runtime.currentMode;
        }
        this.runtime.currentMode = CUSTOM_MODE_NAME;
        this.customOverlay = {
            provider: event.model.provider,
            modelId: event.model.id,
            thinkingLevel: this.pi.getThinkingLevel(),
        };
        if (ctx.hasUI) this.requestEditorRender?.();
    }

    private getFallbackModeSpec(ctx: ExtensionContext): ModeSpec {
        return {
            provider: ctx.model?.provider,
            modelId: ctx.model?.id,
            thinkingLevel: this.pi.getThinkingLevel(),
        };
    }

    private async applyConfiguredDefaultModel(ctx: ExtensionContext): Promise<void> {
        const spec = this.runtime.data.defaultModel;
        if (spec === undefined) return;

        const model = ctx.modelRegistry.find(spec.provider, spec.modelId);
        if (model === undefined) {
            if (ctx.hasUI) {
                ctx.ui.notify(
                    `Default model references unknown model ${spec.provider}/${spec.modelId}`,
                    "warning",
                );
            }

            return;
        }

        this.runtime.applying = true;

        try {
            const applied = await this.pi.setModel(model);
            if (!applied) {
                if (ctx.hasUI) {
                    ctx.ui.notify(
                        `No API key available for ${spec.provider}/${spec.modelId}`,
                        "warning",
                    );
                }

                return;
            }

            if (spec.thinkingLevel !== undefined) this.pi.setThinkingLevel(spec.thinkingLevel);
        } finally {
            this.runtime.applying = false;
        }
    }
}
