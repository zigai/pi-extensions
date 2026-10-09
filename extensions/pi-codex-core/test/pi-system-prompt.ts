import type {
    BuildSystemPromptOptions,
    NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";

type PiSystemPromptModule = {
    readonly buildSystemPrompt: (options: BuildSystemPromptOptions) => string;
    readonly normalizeBuildSystemPromptOptions: (
        options: BuildSystemPromptOptions,
    ) => NormalizedBuildSystemPromptOptions;
};

function isPiSystemPromptModule(value: unknown): value is PiSystemPromptModule {
    // SAFETY: these signatures match the pinned Pi SDK's system-prompt declarations.
    // The guard verifies the private module's callable surface; behavioral tests exercise it.
    return (
        value !== null &&
        typeof value === "object" &&
        "buildSystemPrompt" in value &&
        typeof value.buildSystemPrompt === "function" &&
        "normalizeBuildSystemPromptOptions" in value &&
        typeof value.normalizeBuildSystemPromptOptions === "function"
    );
}

// Resolve relative to Pi's public entry, not the workspace's node_modules layout.
const loaded: unknown = await import(
    new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
);
if (!isPiSystemPromptModule(loaded)) {
    throw new Error("The installed Pi SDK does not expose the expected system-prompt test seam.");
}

export const { buildSystemPrompt, normalizeBuildSystemPromptOptions } = loaded;
