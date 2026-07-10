/**
 * Stable image-content interface retained for existing extension callers.
 * Implementations live in capability-focused sibling modules.
 */
export {
    MAX_INPUT_IMAGE_BYTES,
    generatedPngContent,
    loadImageContent,
    saveGeneratedImage,
    type LoadedImage,
} from "./file-artifacts.ts";
export {
    codexPromptImageTargetDimensions,
    imageContentToDataUrl,
    modelSupportsImages,
    prepareCodexPromptImageContent,
    type ImageDetail,
} from "./codex-prompt.ts";
export { recentImageContents } from "./recent-session.ts";
