import type { GlowupRenderer } from "./tools/protocol/contract.ts";
import { glowupRenderingAdapter } from "./tools/protocol/renderer.ts";
import { registerToolContribution, renderingRuntime } from "./rendering/presentation-registry.ts";
import type { GlowupPresentation } from "./rendering/presentation.ts";
import type { ThirdPartyToolRenderer, ThirdPartyToolRenderingOptions } from "./tools/types.ts";

export {
    registerGlowupPresentation,
    selectGlowupPresentation,
} from "./rendering/presentation-registry.ts";
export type { GlowupPresentation };

export const compactPresentation: GlowupPresentation = {
    renderNode: (...args) => renderingRuntime().compact.renderNode(...args),
    createRenderer: (...args) => renderingRuntime().compact.createRenderer(...args),
};

export const outlinePresentation: GlowupPresentation = {
    renderNode: (...args) => renderingRuntime().outline.renderNode(...args),
    createRenderer: (...args) => renderingRuntime().outline.createRenderer(...args),
};

export function registerGlowupToolRenderer<Args, Result>(
    name: string,
    matches: (toolName: string) => boolean,
    rendering: GlowupRenderer<Args, Result>,
) {
    const contribution = (next: GlowupRenderer<Args, Result>) => {
        const adapter = glowupRenderingAdapter({ glowupRendering: next });
        if (adapter === undefined) throw new Error("Invalid Glowup tool renderer contribution");
        return {
            matches,
            create: (fallback: ThirdPartyToolRenderer, options?: ThirdPartyToolRenderingOptions) =>
                renderingRuntime().createProtocolRenderer(
                    adapter,
                    fallback,
                    options?.labelMode,
                    options?.mutationSettings,
                    options?.streamCode,
                ),
        };
    };

    const registration = registerToolContribution(name, contribution(rendering));

    return {
        update(next: GlowupRenderer<Args, Result>): void {
            registration.update(contribution(next));
        },
        dispose(): void {
            registration.dispose();
        },
    };
}
