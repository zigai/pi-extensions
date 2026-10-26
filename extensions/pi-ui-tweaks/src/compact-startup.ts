import { InteractiveMode, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth } from "@earendil-works/pi-tui";
import { installLinkedMethodPatch, reportExtensionDiagnostic } from "@zigai/pi-extension-internals";

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
    loadedResourcesContainer: { children: Renderable[] };
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
        Array.isArray(view.loadedResourcesContainer?.children) &&
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
    const summary = ` Context ${contextCount} files · Skills ${loader.getSkills().skills.length} · Extensions ${loader.getExtensions().extensions.filter((extension) => extension.hidden !== true).length}`;
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
                    const hints = ` / commands · ! shell · ${mode.keybindings.getKeys("app.tools.expand").join("/")} details`;
                    let title = ` Pi v${mode.version}`;
                    let ready = " Ready";
                    if ("onLogoClick" in header && typeof header.onLogoClick === "function") {
                        title = `${sliceByColumn(native[0] ?? "", 0, 5)}\u001b[0m Pi v${mode.version}`;
                        ready = `${sliceByColumn(native[1] ?? "", 0, 5)}\u001b[0m Ready`;
                    } else {
                        title = native[0] ?? title;
                    }

                    return [title, ready, "", summary, "", hints].map((line) =>
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
