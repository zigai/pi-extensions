import { installKeyedLinkedMethodPatch } from "@zigai/pi-extension-internals";
import { InteractiveMode, type SessionShutdownEvent } from "@earendil-works/pi-coding-agent";

import {
    FOOTER_COMPONENT_KIND,
    isFooterComponent,
    markFooterComponent,
    type FooterComponentKind,
} from "./footer-component.ts";
import { createFooterComponent, type PlainFooterTheme } from "./footer-rendering.ts";
import { getFooterRoute } from "./footer-session-status.ts";
import type { FooterConfig } from "./settings.ts";
import type { ContextUsage, FooterContext, FooterData, FooterModel } from "./footer-model.ts";

const RESET_PATCH_MARKER = Symbol.for("zigai.pi-footer.reset-extension-ui-patch");
const TRANSITION_STATE_KEY = "__zigaiPiFooterTransitionState__";
const BRIDGE_FOOTER_TTL_MS = 15_000;

type FooterComponent = ReturnType<typeof createFooterComponent>;

type FooterTui = {
    requestRender(): void;
    setClearOnShrink?(enabled: boolean): void;
};

type FooterFactory = (
    tui: FooterTui,
    theme: PlainFooterTheme,
    footerData: FooterData,
) => FooterComponent;

type LiveFooterContext = FooterContext & {
    ui: {
        setFooter(factory: FooterFactory | undefined): void;
    };
};

type FooterResetHost = {
    customFooter?: unknown;
    resetExtensionUI(): void;
    setExtensionFooter(factory: FooterFactory | undefined): void;
};

type FooterSnapshot = {
    context: FooterContext;
    thinkingLevel: string;
    config: FooterConfig;
};

type FooterTransitionState = {
    latestSnapshot?: FooterSnapshot;
    pendingShutdownReason?: SessionShutdownEvent["reason"];
    liveInstallGeneration: number;
};

type PatchableInteractiveModePrototype = {
    resetExtensionUI(this: FooterResetHost): void;
    setExtensionFooter(factory: FooterFactory | undefined): void;
};

type FooterTransitionGlobal = typeof globalThis & {
    [TRANSITION_STATE_KEY]?: FooterTransitionState;
};

function isPatchableInteractiveModePrototype(
    value: unknown,
): value is PatchableInteractiveModePrototype {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) {
        return false;
    }

    return (
        "resetExtensionUI" in value &&
        typeof value.resetExtensionUI === "function" &&
        "setExtensionFooter" in value &&
        typeof value.setExtensionFooter === "function"
    );
}

function getTransitionState(): FooterTransitionState {
    // SAFETY: globalThis is the ambient global; FooterTransitionGlobal only adds an optional namespaced transition key.
    const globalState = globalThis as FooterTransitionGlobal;
    let state = globalState[TRANSITION_STATE_KEY];
    if (state === undefined) {
        state = { liveInstallGeneration: 0 };
        globalState[TRANSITION_STATE_KEY] = state;
    }

    return state;
}

function cloneContextUsage(usage: ContextUsage): ContextUsage {
    if (usage === undefined) return undefined;

    return { ...usage };
}

function resolveProviderDisplayName(ctx: FooterContext, provider: string): string | undefined {
    if (ctx.modelRegistry === undefined) return undefined;
    try {
        const displayName = ctx.modelRegistry.getProviderDisplayName(provider);
        if (displayName.length > 0) {
            return displayName;
        }
    } catch {
        return undefined;
    }

    return undefined;
}

function cloneModel(ctx: FooterContext): FooterModel | undefined {
    const model = ctx.model;
    if (model === undefined) return undefined;

    const cloned: FooterModel = {
        api: model.api,
        provider: model.provider,
        id: model.id,
        contextWindow: model.contextWindow,
    };
    if (model.name !== undefined) {
        cloned.name = model.name;
    }

    const providerDisplayName = resolveProviderDisplayName(ctx, model.provider);
    if (providerDisplayName !== undefined) {
        cloned.providerDisplayName = providerDisplayName;
    }

    return cloned;
}

function cloneMcpServers(ctx: FooterContext): unknown[] | undefined {
    const count = ctx.getMcpServerCount?.() ?? ctx.mcpServers?.length;
    if (count === undefined) return undefined;
    return Array.from<unknown>({ length: count });
}

function createFooterSnapshot(
    ctx: FooterContext,
    thinkingLevel: string,
    config: FooterConfig,
): FooterSnapshot {
    const usage = cloneContextUsage(ctx.getContextUsage());

    return {
        context: {
            cwd: ctx.cwd,
            model: cloneModel(ctx),
            mcpServers: cloneMcpServers(ctx),
            routedModel: getFooterRoute(ctx),
            getContextUsage() {
                return usage;
            },
        },
        thinkingLevel,
        config,
    };
}

function shouldBridgeFooter(
    kind: FooterComponentKind | undefined,
    state: FooterTransitionState,
): boolean {
    if (kind === undefined) return false;
    if (state.latestSnapshot === undefined) return false;

    // Session replacements tear down extension UI after `session_shutdown`, but
    // `/reload` calls `resetExtensionUI()` before the shutdown event. Treat an
    // otherwise-active footer with no pending reason as that pre-shutdown reload
    // reset so Pi's built-in footer is not restored while reload is in progress.
    if (state.pendingShutdownReason === "quit") return false;
    return true;
}

function installBridgeFooter(host: FooterResetHost, snapshot: FooterSnapshot): void {
    const generationAtInstall = getTransitionState().liveInstallGeneration;

    host.setExtensionFooter((tui, theme, footerData) => {
        const component = createFooterComponent(
            snapshot.context,
            footerData,
            () => snapshot.thinkingLevel,
            () => tui.requestRender(),
            snapshot.config,
            theme,
        );
        return markFooterComponent(component, "bridge");
    });

    const timeout = setTimeout(() => {
        const state = getTransitionState();
        if (state.liveInstallGeneration !== generationAtInstall) return;

        const footer = host.customFooter;
        if (!isFooterComponent(footer) || footer[FOOTER_COMPONENT_KIND] !== "bridge") return;

        host.setExtensionFooter(undefined);
    }, BRIDGE_FOOTER_TTL_MS);

    timeout.unref();
}

function bridgeAfterFooterReset(
    host: FooterResetHost,
    footerKind: FooterComponentKind | undefined,
    snapshot: FooterSnapshot | undefined,
    state: FooterTransitionState,
): void {
    if (!shouldBridgeFooter(footerKind, state)) return;
    if (snapshot === undefined) return;

    installBridgeFooter(host, snapshot);
}

export function patchFooterReset(): void {
    // Pi resets extension-owned UI between session replacements before the
    // replacement session has emitted session_start. Reinstall a snapshot-backed
    // bridge footer in that same reset call so the built-in footer never paints
    // during the handoff.
    const prototypeValue: unknown = InteractiveMode.prototype;
    if (!isPatchableInteractiveModePrototype(prototypeValue)) return;

    const prototype = prototypeValue;

    installKeyedLinkedMethodPatch(
        prototype,
        "resetExtensionUI",
        RESET_PATCH_MARKER,
        bridgeAfterFooterReset,
        (predecessor, getAfterReset) =>
            function (this: FooterResetHost): void {
                let footerKind: FooterComponentKind | undefined;
                if (isFooterComponent(this.customFooter)) {
                    footerKind = this.customFooter[FOOTER_COMPONENT_KIND];
                }

                const state = getTransitionState();
                const snapshot = state.latestSnapshot;
                predecessor.call(this);
                state.pendingShutdownReason = undefined;
                getAfterReset()(this, footerKind, snapshot, state);
            },
    );
}

export function installLiveFooter(
    ctx: LiveFooterContext,
    getThinkingLevel: () => string,
    config: FooterConfig,
): void {
    ctx.ui.setFooter((tui, theme, footerData) => {
        const component = createFooterComponent(
            ctx,
            footerData,
            getThinkingLevel,
            () => tui.requestRender(),
            config,
            theme,
        );
        return markFooterComponent(component, "live");
    });

    const state = getTransitionState();
    state.latestSnapshot = createFooterSnapshot(ctx, getThinkingLevel(), config);
    state.pendingShutdownReason = undefined;
    state.liveInstallGeneration += 1;
}

export function rememberFooterForTransition(
    ctx: FooterContext,
    reason: SessionShutdownEvent["reason"],
    thinkingLevel: string,
    config: FooterConfig,
): void {
    const state = getTransitionState();
    state.pendingShutdownReason = reason;

    if (reason === "quit") {
        state.latestSnapshot = undefined;
        return;
    }

    state.latestSnapshot = createFooterSnapshot(ctx, thinkingLevel, config);
}
