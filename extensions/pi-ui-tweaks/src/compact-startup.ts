import {
    getSelectListTheme,
    InteractiveMode,
    type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
    sliceByColumn,
    stripTerminalSequences,
    truncateToWidth,
    wrapTextWithAnsi,
    type TuiMouseEvent,
    type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { installLinkedMethodPatch, reportExtensionDiagnostic } from "@zigai/pi-extension-internals";

import type { LoadedUiTweaksConfig } from "./settings-input.ts";
import { getCachedSkillTokens } from "./skill-token-cache.ts";
import { enlargeStartupLogo } from "./startup-logo.ts";
import { homedir } from "node:os";
import { sep } from "node:path";

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
    session: { resourceLoader: StartupResources; readonly systemPrompt: string };
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
        typeof view.session?.systemPrompt === "string" &&
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

type SummaryRow = { label: string; value: string };

function displayContextPath(path: string): string {
    const home = homedir();
    let display = path;
    if (path.startsWith(`${home}${sep}`)) display = `~${path.slice(home.length)}`;

    return stripTerminalSequences(display)
        .replaceAll("\n", "\\n")
        .replaceAll("\r", "\\r")
        .replaceAll("\t", "\\t");
}

function collectSummary(mode: StartupMode): SummaryRow[] {
    const loader = mode.session.resourceLoader;
    const system = loader.getSystemPromptSource();
    const paths = loader.getAppendSystemPromptSources().map((file) => file.path);
    if (system !== undefined) paths.unshift(system.path);
    paths.push(...loader.getAgentsFiles().agentsFiles.map((file) => file.path));

    const rows: SummaryRow[] = [];
    for (const path of paths) {
        let label = "";
        if (rows.length === 0) label = "Context";
        rows.push({ label, value: displayContextPath(path) });
    }

    if (paths.length === 0) rows.push({ label: "Context", value: "0 files" });

    const tokens = getCachedSkillTokens(mode.session.systemPrompt);
    rows.push({
        label: "Skills",
        value: `${loader.getSkills().skills.length} · ~${tokens.toLocaleString("en-US")} tokens`,
    });
    rows.push({
        label: "Extensions",
        value: String(
            loader.getExtensions().extensions.filter((extension) => extension.hidden !== true)
                .length,
        ),
    });

    return rows;
}

function renderSummary(rows: readonly SummaryRow[], width: number, indentWidth: number): string[] {
    const indent = " ".repeat(indentWidth);
    const valueColumn = indentWidth + 12;
    const lines: string[] = [];
    for (const row of rows) {
        const prefix = `${indent}${row.label.padEnd(12)}`;

        if (width <= valueColumn) {
            lines.push(
                truncateToWidth(`${indent}${row.label} ${row.value}`, Math.max(0, width), ""),
            );
            continue;
        }

        const wrapped = wrapTextWithAnsi(row.value, width - valueColumn);
        for (const [index, part] of wrapped.entries()) {
            let padding = " ".repeat(valueColumn);
            if (index === 0) padding = prefix;
            lines.push(`${padding}${part}`);
        }
    }

    return lines;
}

type MouseHeader = Renderable & {
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
};

function hasMouseHandler(header: Renderable): header is MouseHeader {
    return "handleMouse" in header && typeof header.handleMouse === "function";
}

function installInstance(mode: StartupMode, enabled: () => boolean): Handle {
    const patches: { dispose(): void }[] = [];
    let expanded = mode.options.verbose === true || mode.toolOutputExpanded;
    let enlargedLogo = false;

    const active = (): boolean =>
        enabled() &&
        (mode.customHeader === undefined || mode.customHeader === null) &&
        mode.settingsManager.getQuietStartup() !== true;

    let resources: SummaryRow[] = [];
    if (enabled()) resources = collectSummary(mode);

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
                    if (!active() || expanded) {
                        enlargedLogo = false;
                        return predecessor.call(this, width);
                    }

                    const native = predecessor.call(this, Math.max(width, 80));
                    const muted = getSelectListTheme().description;
                    let title = muted(` Pi v${mode.version}`);
                    let logoBottom = "";
                    let indentWidth = 6;
                    let logoRows: string[] | undefined;
                    if ("onLogoClick" in header && typeof header.onLogoClick === "function") {
                        logoRows = enlargeStartupLogo(native);
                        title = `${sliceByColumn(native[0] ?? "", 0, 5)}\u001b[0m${muted(` Pi v${mode.version}`)}`;
                        logoBottom = `${sliceByColumn(native[1] ?? "", 0, 5)}\u001b[0m`;
                    } else {
                        title = native[0] ?? title;
                    }

                    enlargedLogo = logoRows !== undefined;

                    let heading = [title, logoBottom];
                    if (logoRows !== undefined) {
                        indentWidth = 10;
                        heading = logoRows.map((row, index) => {
                            let line = ` ${row}`;
                            if (index === 0) line += muted(` Pi v${mode.version}`);

                            return line;
                        });
                    }

                    return [
                        ...heading,
                        "",
                        ...renderSummary(resources, width, indentWidth).map(muted),
                    ].map((line) => truncateToWidth(line, Math.max(0, width), ""));
                },
        ),
    );

    if (hasMouseHandler(header)) {
        patches.push(
            installLinkedMethodPatch(
                header,
                "handleMouse",
                (predecessor) =>
                    function (event) {
                        if (
                            enlargedLogo &&
                            active() &&
                            !expanded &&
                            event.type === "click" &&
                            event.x >= 1 &&
                            event.x <= 8 &&
                            event.y >= 0 &&
                            event.y < 4
                        ) {
                            const x = 1 + Math.floor((event.x - 1) / 2);
                            const y = Math.floor(event.y / 2);

                            return predecessor.call(this, {
                                ...event,
                                x,
                                y,
                                screenX: event.screenX - event.x + x,
                                screenY: event.screenY - event.y + y,
                            });
                        }

                        return predecessor.call(this, event);
                    },
            ),
        );
    }

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
        update(): void {
            if (enabled()) resources = collectSummary(mode);
        },
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

            for (const [mode, instance] of instances) {
                instance.update(next);
                mode.ui.requestRender();
            }
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
