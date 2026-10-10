import { applyThinkingLevelStatusPatch, type ThinkingLevelStatusPatchOptions } from "./status.ts";

type InstallThinkingLevelStatusPatch = (
    options: ThinkingLevelStatusPatchOptions,
) => Promise<() => void>;

/** Owns one thinking-status patch activation and its cleanup for the current Pi session. */
export class ThinkingStatusPatchSession {
    private generation = 0;
    private activation: Promise<void> | undefined;
    private restore = (): void => {};

    constructor(
        private readonly install: InstallThinkingLevelStatusPatch = applyThinkingLevelStatusPatch,
    ) {}

    async activate(shouldShowThinkingLevelStatus: () => boolean): Promise<void> {
        if (this.activation !== undefined) return this.activation;

        const generation = this.generation;
        const pending = this.install({ shouldShowThinkingLevelStatus }).then((restore) => {
            if (generation !== this.generation || this.activation !== pending) {
                restore();
                return;
            }

            this.restore = restore;
        });

        this.activation = pending;
        return pending;
    }

    reset(): void {
        this.generation += 1;
        this.activation = undefined;

        const restore = this.restore;

        this.restore = (): void => {};
        restore();
    }
}
