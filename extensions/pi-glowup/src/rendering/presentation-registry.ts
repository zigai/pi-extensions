import {
    compactPresentation,
    outlinePresentation,
    type GlowupPresentation,
} from "./presentation.ts";
import type { ThirdPartyToolRenderer, ThirdPartyToolRenderingOptions } from "../tools/types.ts";
import { createProtocolRenderer } from "../tools/protocol/renderer.ts";

type RenderingRuntime = {
    readonly compact: GlowupPresentation;
    readonly outline: GlowupPresentation;
    readonly createProtocolRenderer: typeof createProtocolRenderer;
};

type Contribution = {
    readonly matches: (toolName: string) => boolean;

    readonly create: (
        fallback: ThirdPartyToolRenderer,
        options?: ThirdPartyToolRenderingOptions,
    ) => ThirdPartyToolRenderer;
};

type RenderingRegistry = {
    readonly version: number;
    readonly presentations: Map<string, GlowupPresentation>;
    readonly contributions: Map<string, Contribution>;
    readonly listeners: Set<() => void>;
    runtime: RenderingRuntime;
    selected: string;
    previousSelection: string;
    revision: number;
};

const REGISTRY = Symbol.for("zigai.pi-glowup.rendering-registry");

function registry(): RenderingRegistry {
    const state: typeof globalThis & { [REGISTRY]?: RenderingRegistry } = globalThis;

    state[REGISTRY] ??= {
        version: 1,
        presentations: new Map([
            ["compact", compactPresentation],
            ["outline", outlinePresentation],
        ]),
        contributions: new Map(),
        listeners: new Set(),
        runtime: {
            compact: compactPresentation,
            outline: outlinePresentation,
            createProtocolRenderer,
        },
        selected: "compact",
        previousSelection: "compact",
        revision: 0,
    };

    const current = state[REGISTRY];
    if (current.version !== 1) throw new Error("Unsupported Glowup rendering registry version");
    return current;
}

export function activateGlowupRendering(): void {
    const state = registry();
    state.runtime = {
        compact: compactPresentation,
        outline: outlinePresentation,
        createProtocolRenderer,
    };
    state.presentations.set("compact", compactPresentation);
    state.presentations.set("outline", outlinePresentation);
}

export function renderingRuntime(): RenderingRuntime {
    return registry().runtime;
}

function changed(): void {
    const state = registry();
    state.revision += 1;
    for (const listener of state.listeners) listener();
}

export function selectGlowupPresentation(name: string): void {
    if (!registry().presentations.has(name))
        throw new Error(`Unknown Glowup presentation: ${name}`);

    const state = registry();
    if (state.selected !== name) state.previousSelection = state.selected;
    state.selected = name;
    changed();
}

export function registerGlowupPresentation(name: string, presentation: GlowupPresentation) {
    const state = registry();
    if (state.presentations.has(name))
        throw new Error(`Glowup presentation already registered: ${name}`);

    state.presentations.set(name, presentation);
    changed();

    let disposed = false;

    return {
        update(next: GlowupPresentation): void {
            if (disposed) return;

            state.presentations.set(name, next);
            changed();
        },
        dispose(): void {
            if (disposed) return;

            disposed = true;
            state.presentations.delete(name);

            if (state.selected === name) {
                state.selected = state.previousSelection;
                if (!state.presentations.has(state.selected)) state.selected = "compact";
            }

            changed();
        },
    };
}

function changeContribution(name: string, contribution: Contribution | undefined): void {
    const state = registry();
    const previous = state.contributions.get(name);

    if (contribution === undefined) state.contributions.delete(name);
    else state.contributions.set(name, contribution);

    try {
        changed();
    } catch (cause) {
        if (previous === undefined) state.contributions.delete(name);
        else state.contributions.set(name, previous);

        try {
            changed();
        } catch (restoreCause) {
            throw new AggregateError([cause, restoreCause], "Glowup renderer rollback failed");
        }

        throw cause;
    }
}

export function registerToolContribution(name: string, contribution: Contribution) {
    const state = registry();
    if (state.contributions.has(name))
        throw new Error(`Glowup tool renderer already registered: ${name}`);

    changeContribution(name, contribution);

    let disposed = false;

    return {
        update(next: Contribution): void {
            if (disposed) return;

            changeContribution(name, next);
        },
        dispose(): void {
            if (disposed) return;

            changeContribution(name, undefined);
            disposed = true;
        },
    };
}

export function selectedGlowupPresentation(): GlowupPresentation {
    const state = registry();
    const presentation = state.presentations.get(state.selected);
    if (presentation === undefined) throw new Error("Selected Glowup presentation is unavailable");
    return presentation;
}

export function contributedToolRenderer(toolName: string): Contribution | undefined {
    return [...registry().contributions.values()].find((entry) => entry.matches(toolName));
}

export function observeGlowupRendering(listener: () => void): () => void {
    registry().listeners.add(listener);

    return () => {
        registry().listeners.delete(listener);
    };
}
