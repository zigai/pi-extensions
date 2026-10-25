/** Generated display content. Logs, diffs, transport events and persisted inputs stay raw. */
export type GlowupContentKind = "prose" | "markdown" | "code";

/** Optional declaration on a generated-content node; absent on ordinary output/log nodes. */
export type GlowupStreaming = {
    readonly kind: GlowupContentKind;

    /** Override the enclosing call/result lifecycle, for example for a live child snapshot. */
    readonly complete?: boolean;

    /** Stable logical identity within this tool call, independent of node position. */
    readonly key?: string;
    readonly mode?: "inherit" | "immediate";
};

export type GlowupContentInput = {
    readonly key: string;
    readonly kind: GlowupContentKind;
    readonly source: string;
    readonly complete: boolean;
    readonly language?: string;
    readonly path?: string;
    readonly targetWidth?: number;
    readonly invalidate?: () => void;
    readonly mode?: "inherit" | "immediate";

    /** Owning tool call, used only to attribute render diagnostics. */
    readonly toolCallId?: string;
};

/** A replaceable presentation-only policy. It must never modify source/history or execute code. */
export type GlowupStreamingPolicy = {
    present(input: GlowupContentInput): string;
    settled(): Promise<void>;
};

const POLICY = Symbol.for("zigai.pi-glowup.streaming-policy.v1");

type PolicyRegistry = { readonly policies: Map<symbol, GlowupStreamingPolicy> };

function registry(): PolicyRegistry {
    const owner: typeof globalThis & { [POLICY]?: PolicyRegistry } = globalThis;
    owner[POLICY] ??= { policies: new Map() };
    return owner[POLICY];
}

function selectedPolicy(): [symbol, GlowupStreamingPolicy] | undefined {
    return [...registry().policies.entries()].at(-1);
}

/** Installs a session-owned policy. Disposing out of order never resurrects a disposed owner. */
export function registerGlowupStreamingPolicy(policy: GlowupStreamingPolicy) {
    const key = Symbol();
    const policies = registry().policies;
    policies.set(key, policy);

    return {
        dispose: () => {
            policies.delete(key);
        },
    };
}

/** Public non-TUI seam for extension-owned generated previews. Without a policy, preserves source. */
export function presentGlowupContent(input: GlowupContentInput): string {
    if (input.mode === "immediate") return input.source;
    return selectedPolicy()?.[1].present(input) ?? input.source;
}

/** A request-time snapshot can await parsing without owning a renderer or retaining a UI context. */
export async function presentGlowupSnapshot(input: GlowupContentInput): Promise<string> {
    const selected = selectedPolicy();
    if (selected === undefined || input.mode === "immediate") return input.source;

    const [generation, policy] = selected;
    policy.present(input);
    await policy.settled();

    // A reset/reload must not publish a previous session's processed snapshot.
    if (selectedPolicy()?.[0] !== generation) return "";
    return policy.present(input);
}
