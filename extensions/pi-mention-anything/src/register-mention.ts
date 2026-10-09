import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { InitialSuggestions } from "./initial-suggestions.ts";
import type { SourceControllerOptions } from "./source-controller.ts";
import type { Candidate, Provider } from "./source-contract.ts";
import { sharedHub, type MentionHub } from "./mention-hub.ts";

export type MentionProviderContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;
export type MentionContext = MentionProviderContext;
export type MentionExtensionApi = Pick<ExtensionAPI, "on">;

type ControllerConfiguration<T> = T extends SourceControllerOptions
    ? Omit<T, "sourceId" | "cwd" | "trusted" | "onError">
    : never;

export type MentionConfiguration = ControllerConfiguration<SourceControllerOptions> & {
    readonly trigger: string;
    readonly separator?: string;
    readonly completionSuffix?: string;
    readonly initialSuggestions?: InitialSuggestions;
    readonly expansionPolicy?: "selected-only" | "selected-or-resolved";
    readonly replacementTemplate?: string;
};

export type MentionRegistration = {
    readonly id: string;
    readonly configuration: (ctx: MentionProviderContext) => MentionConfiguration;
    readonly provider: (ctx: MentionProviderContext) => Provider;

    readonly replacement?: (
        path: readonly Candidate[],
        ctx: MentionProviderContext,
        options: { readonly signal?: AbortSignal },
    ) => string | Promise<string>;
};

/** Composition seam used by settings to construct the same registrations as TypeScript providers. */
export function registerMentionSources(
    pi: Pick<ExtensionAPI, "on">,
    load: (ctx: MentionProviderContext) => readonly MentionRegistration[],
): void {
    let hub: MentionHub | undefined;
    let owned: symbol[] = [];

    pi.on("session_start", async (_event, ctx) => {
        if (hub !== undefined) for (const handle of owned) await hub.remove(handle);

        owned = [];

        const registrations = load(ctx);

        hub = undefined;

        if (registrations.length === 0) return;

        hub = sharedHub(ctx);
        for (const registration of registrations) owned.push(hub.add(registration));
    });

    pi.on("input", (event) => {
        hub?.input(event.text);
        return { action: "continue" };
    });

    pi.on("context", async (event, ctx) => {
        if (hub === undefined) return undefined;

        const messages = await hub.context(event.messages, ctx.signal);
        if (messages !== event.messages) return { messages };
        return undefined;
    });

    pi.on("session_shutdown", async () => {
        const previous = hub;
        hub = undefined;

        const handles = owned;
        owned = [];

        if (previous !== undefined) for (const handle of handles) await previous.remove(handle);
    });
}

/** Register a domain provider; the shared hub owns editor, cache and expansion lifetimes. */
export function registerMention(
    pi: Pick<ExtensionAPI, "on">,
    registration: MentionRegistration,
): void {
    registerMentionSources(pi, () => [registration]);
}
