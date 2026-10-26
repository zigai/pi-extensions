import {
    getSelectListTheme,
    InteractiveMode,
    type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth } from "@earendil-works/pi-tui";
import { installLinkedMethodPatch, reportExtensionDiagnostic } from "@zigai/pi-extension-internals";

import type { LoadedUiTweaksConfig } from "./settings-input.ts";

const COMPACT_STARTUP_PATCH = Symbol.for("zigai.pi-ui-tweaks.compact-startup-patch");

export type CompactStartupConfig = { readonly compactStartup: boolean };
type Handle = { update(config: CompactStartupConfig): void; dispose(): void };
type Renderable = { render(width: number): string[] };
type Expandable = Renderable & { setExpanded(expanded: boolean): void };

type StartupResources = Pick<
    ResourceLoader,
    | "getSkills"
    | "getExtensions"
    | "getAgentsFiles"
    | "getSystemPromptSource"
    | "getAppendSystemPromptSources"
>;

type StartupMode = {
    builtInHeader: Renderable;
    customHeader?: Renderable | null;
    version: string;
    toolOutputExpanded: boolean;
    options: { verbose?: boolean };
    settingsManager: { getQuietStartup(): boolean | "header" };
    keybindings: { getKeys(action: "app.tools.expand"): string[] };
    session: { resourceLoader: StartupResources };
    loadedResourcesContainer: Renderable & { children: Renderable[] };
    ui: { requestRender(): void };
};

type ShowResourcesOptions = {
    force?: boolean;
    showDiagnosticsWhenQuiet?: boolean;

    extensions?: Pick<
        ReturnType<ResourceLoader["getExtensions"]>["extensions"][number],
        "path" | "sourceInfo"
    >[];
};

type ShowResources = (this: StartupMode, options?: ShowResourcesOptions) => void;
type ShowResourcesView = { readonly showLoadedResources?: ShowResources };
type PatchTarget = { showLoadedResources: ShowResources; [COMPACT_STARTUP_PATCH]?: Handle };

function isObject(value: unknown): value is object {
    return typeof value === "object" && value !== null;
}

function isRenderable(value: unknown): value is Renderable {
    return isObject(value) && "render" in value && typeof value.render === "function";
}

function isExpandable(value: Renderable): value is Expandable {
    return "setExpanded" in value && typeof value.setExpanded === "function";
}

function isStartupMode(value: unknown): value is StartupMode {
    if (!isObject(value)) return false;

    // SAFETY: Every private member used below is checked before the view escapes.
    const view = value as Partial<StartupMode>;
    const loader = view.session?.resourceLoader;

    return (
        isRenderable(view.builtInHeader) &&
        typeof view.version === "string" &&
        typeof view.toolOutputExpanded === "boolean" &&
        isObject(view.options) &&
        typeof view.settingsManager?.getQuietStartup === "function" &&
        typeof view.keybindings?.getKeys === "function" &&
        typeof view.ui?.requestRender === "function" &&
        isRenderable(view.loadedResourcesContainer) &&
        Array.isArray(view.loadedResourcesContainer.children) &&
        view.loadedResourcesContainer.children.every(isRenderable) &&
        typeof loader?.getSkills === "function" &&
        typeof loader.getExtensions === "function" &&
        typeof loader.getAgentsFiles === "function" &&
        typeof loader.getSystemPromptSource === "function" &&
        typeof loader.getAppendSystemPromptSources === "function"
    );
}

function isPatchTarget(value: unknown): value is PatchTarget {
    return (
        isObject(value) &&
        "showLoadedResources" in value &&
        typeof value.showLoadedResources === "function"
    );
}

function isSpacer(value: Renderable): boolean {
    return "setLines" in value && typeof value.setLines === "function";
}

function installInstance(mode: StartupMode, enabled: () => boolean): Handle {
    const patches: { dispose(): void }[] = [];
    let expanded = mode.options.verbose === true || mode.toolOutputExpanded;
    const active = (): boolean =>
        enabled() &&
        (mode.customHeader === undefined || mode.customHeader === null) &&
        mode.settingsManager.getQuietStartup() !== true;

    const loader = mode.session.resourceLoader;
    const contextCount =
        loader.getAgentsFiles().agentsFiles.length +
        loader.getAppendSystemPromptSources().length +
        Number(loader.getSystemPromptSource() !== undefined);
    const summary = `      Context ${contextCount} files · Skills ${loader.getSkills().skills.length} · Extensions ${loader.getExtensions().extensions.filter((extension) => extension.hidden !== true).length}`;
    const header = mode.builtInHeader;
    if (isExpandable(header)) {
        patches.push(
            installLinkedMethodPatch(
                header,
                "setExpanded",
                (predecessor) =>
                    function (next): void {
                        expanded = next;
                        predecessor.call(this, next);
                    },
            ),
        );
    }

    patches.push(
        installLinkedMethodPatch(
            header,
            "render",
            (predecessor) =>
                function (width): string[] {
                    if (!active() || expanded) return predecessor.call(this, width);

                    const native = predecessor.call(this, Math.max(width, 80));
                    const hints = `      / commands · ! shell · ${mode.keybindings.getKeys("app.tools.expand").join("/")} details`;
                    const muted = getSelectListTheme().description;
                    let title = muted(` Pi v${mode.version}`);
                    let logoBottom = "";
                    if ("onLogoClick" in header && typeof header.onLogoClick === "function") {
                        title = `${sliceByColumn(native[0] ?? "", 0, 5)}\u001b[0m${muted(` Pi v${mode.version}`)}`;
                        logoBottom = `${sliceByColumn(native[1] ?? "", 0, 5)}\u001b[0m`;
                    } else {
                        title = native[0] ?? title;
                    }

                    return [title, logoBottom, "", muted(summary), "", muted(hints)].map((line) =>
                        truncateToWidth(line, Math.max(0, width), ""),
                    );
                },
        ),
    );

    const children = mode.loadedResourcesContainer.children;
    for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        let previous: Renderable | undefined;
        if (index > 0) previous = children.at(index - 1);

        const next = children.at(index + 1);
        if (
            !isExpandable(child) &&
            !(
                isSpacer(child) &&
                ((previous !== undefined && isExpandable(previous)) ||
                    (index === 0 && next !== undefined && isExpandable(next)))
            )
        )
            continue;

        if (isExpandable(child)) {
            patches.push(
                installLinkedMethodPatch(
                    child,
                    "setExpanded",
                    (predecessor) =>
                        function (value): void {
                            expanded = value;
                            predecessor.call(this, value);
                        },
                ),
            );
        }

        patches.push(
            installLinkedMethodPatch(
                child,
                "render",
                (predecessor) =>
                    function (width): string[] {
                        if (active() && !expanded) return [];
                        return predecessor.call(this, width);
                    },
            ),
        );
    }

    return {
        update(): void {},
        dispose(): void {
            for (const patch of patches.reverse()) patch.dispose();
        },
    };
}

export function installCompactStartupPatch(
    config: CompactStartupConfig,
    target?: ShowResourcesView | null,
): Handle {
    let candidate = target;
    if (candidate === undefined && isPatchTarget(InteractiveMode.prototype))
        candidate = InteractiveMode.prototype;

    if (!isPatchTarget(candidate)) {
        reportExtensionDiagnostic(
            "[pi-ui-tweaks] compact startup patch unavailable; Pi internals may have changed: missing showLoadedResources",
        );

        return { update(): void {}, dispose(): void {} };
    }

    const prototype = candidate;
    const existing = prototype[COMPACT_STARTUP_PATCH];
    if (existing !== undefined) {
        existing.update(config);
        return existing;
    }

    let current = config;
    let disposed = false;
    let warned = false;
    const instances = new Map<StartupMode, Handle>();
    const restoreInstances = (): void => {
        for (const handle of instances.values()) handle.dispose();
        instances.clear();
    };

    const patch = installLinkedMethodPatch(
        prototype,
        "showLoadedResources",
        (predecessor) =>
            function (options): void {
                if (isStartupMode(this)) {
                    instances.get(this)?.dispose();
                    instances.delete(this);
                }

                predecessor.call(this, options);

                if (!isStartupMode(this)) {
                    if (!current.compactStartup) return;

                    if (!warned)
                        reportExtensionDiagnostic(
                            "[pi-ui-tweaks] compact startup patch unavailable; Pi startup components may have changed",
                        );

                    warned = true;
                    return;
                }

                instances.set(
                    this,
                    installInstance(this, () => current.compactStartup),
                );
            },
    );
    const handle: Handle = {
        update(next): void {
            if (disposed) return;

            current = next;

            for (const mode of instances.keys()) mode.ui.requestRender();
        },
        dispose(): void {
            if (disposed) return;

            disposed = true;
            restoreInstances();
            patch.dispose();

            if (prototype[COMPACT_STARTUP_PATCH] === handle)
                delete prototype[COMPACT_STARTUP_PATCH];
        },
    };

    prototype[COMPACT_STARTUP_PATCH] = handle;
    return handle;
}

const STARTUP_BOOTSTRAP_PATCH = Symbol.for("zigai.pi-ui-tweaks.startup-bootstrap-patch");

type SettingsReader = (cwd: string, projectTrusted: boolean) => LoadedUiTweaksConfig;
type BootstrapHandle = { readSettings: SettingsReader; dispose(): void };

type BootstrapMode = {
    sessionManager: { getCwd(): string };
    settingsManager: { isProjectTrusted(): boolean };
    headerContainer: { addChild(child: Renderable): void };
};

type InitView = { init?: (this: BootstrapMode) => Promise<void> };
type InitTarget = Required<InitView> & { [STARTUP_BOOTSTRAP_PATCH]?: BootstrapHandle };

function isBootstrapMode(value: unknown): value is BootstrapMode {
    if (!isObject(value)) return false;

    // SAFETY: Every startup member used below is validated before use.
    const view = value as Partial<BootstrapMode>;
    return (
        typeof view.sessionManager?.getCwd === "function" &&
        typeof view.settingsManager?.isProjectTrusted === "function" &&
        typeof view.headerContainer?.addChild === "function"
    );
}

function isInitTarget(value: InitView | null): value is InitTarget {
    return value !== null && typeof value.init === "function";
}

type ReloadTarget = { handleReloadCommand(this: StartupMode): Promise<void> };

function isReloadTarget(value: unknown): value is ReloadTarget {
    return (
        isObject(value) &&
        "handleReloadCommand" in value &&
        typeof value.handleReloadCommand === "function"
    );
}

function holdFrame(component: Renderable): { dispose(): void } {
    const lines = component.render(4096);

    return installLinkedMethodPatch(
        component,
        "render",
        () =>
            (width): string[] =>
                lines.map((line) => truncateToWidth(line, Math.max(0, width), "")),
    );
}

/** Stage the compact header before its first mount, not after session_start. */
export function installCompactStartupBootstrap(
    loadSettings: SettingsReader,
    target: InitView | null = InteractiveMode.prototype,
): BootstrapHandle {
    if (!isInitTarget(target)) {
        reportExtensionDiagnostic(
            "[pi-ui-tweaks] compact startup first-frame hook unavailable: missing init",
        );

        return { readSettings: loadSettings, dispose(): void {} };
    }

    const prototype = target;
    const existing = prototype[STARTUP_BOOTSTRAP_PATCH];
    if (existing !== undefined) return existing;

    let compact = false;
    let pending: { cwd: string; trusted: boolean; loaded: LoadedUiTweaksConfig } | undefined;
    const patch = installLinkedMethodPatch(
        prototype,
        "init",
        (predecessor) =>
            async function (): Promise<void> {
                if (!isBootstrapMode(this)) {
                    reportExtensionDiagnostic(
                        "[pi-ui-tweaks] compact startup first-frame hook unavailable: changed startup components",
                    );
                    return predecessor.call(this);
                }

                const cwd = this.sessionManager.getCwd();
                const trusted = this.settingsManager.isProjectTrusted();
                const loaded = loadSettings(cwd, trusted);
                compact = loaded.config.compactStartup;
                pending = { cwd, trusted, loaded };

                let earlyHeader: Handle | undefined;
                const mount = installLinkedMethodPatch(
                    this.headerContainer,
                    "addChild",
                    (addChild) =>
                        (child): void => {
                            if (
                                loaded.config.compactStartup &&
                                isStartupMode(this) &&
                                child === this.builtInHeader
                            ) {
                                earlyHeader?.dispose();
                                earlyHeader = installInstance(this, () => true);
                            }

                            addChild.call(this.headerContainer, child);
                        },
                );

                try {
                    await predecessor.call(this);
                } finally {
                    mount.dispose();
                    earlyHeader?.dispose();
                    pending = undefined;
                }
            },
    );
    let reloadPatch: { dispose(): void } | undefined;
    if (isReloadTarget(prototype)) {
        reloadPatch = installLinkedMethodPatch(
            prototype,
            "handleReloadCommand",
            (predecessor) =>
                async function (): Promise<void> {
                    if (
                        !compact ||
                        !isStartupMode(this) ||
                        this.toolOutputExpanded ||
                        this.customHeader !== undefined ||
                        this.settingsManager.getQuietStartup() === true
                    )
                        return predecessor.call(this);

                    const header = holdFrame(this.builtInHeader);
                    const resources = holdFrame(this.loadedResourcesContainer);
                    try {
                        await predecessor.call(this);
                    } finally {
                        resources.dispose();
                        header.dispose();
                    }
                },
        );
    }

    let disposed = false;
    const handle: BootstrapHandle = {
        readSettings(cwd, projectTrusted): LoadedUiTweaksConfig {
            const cached = pending;
            pending = undefined;

            let loaded: LoadedUiTweaksConfig;
            if (cached?.cwd === cwd && cached.trusted === projectTrusted) loaded = cached.loaded;
            else loaded = loadSettings(cwd, projectTrusted);

            compact = loaded.config.compactStartup;
            return loaded;
        },
        dispose(): void {
            if (disposed) return;

            disposed = true;
            pending = undefined;
            reloadPatch?.dispose();
            patch.dispose();

            if (prototype[STARTUP_BOOTSTRAP_PATCH] === handle)
                delete prototype[STARTUP_BOOTSTRAP_PATCH];
        },
    };

    prototype[STARTUP_BOOTSTRAP_PATCH] = handle;
    return handle;
}
