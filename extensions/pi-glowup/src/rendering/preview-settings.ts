export type MutationDefaultView = "full" | "preview";

export type MutationLimits = {
    readonly maxDiffBytes: number | null;
    readonly maxDiffLines: number | null;
    readonly maxWritePreviewBytes: number | null;
    readonly maxDeletePreimageBytes: number | null;
};

/** User-facing policy shared by native and compatible third-party mutation renderers. */
export type MutationSettings = {
    readonly defaultView: MutationDefaultView;
    readonly previewLines: number;
    readonly limits: MutationLimits;
};

export const DEFAULT_MUTATION_SETTINGS: MutationSettings = {
    defaultView: "full",
    previewLines: 6,
    limits: {
        maxDiffBytes: 512 * 1024,
        maxDiffLines: 5_000,
        maxWritePreviewBytes: 64 * 1024,
        maxDeletePreimageBytes: 256 * 1024,
    },
};

/** Previous completed-mutation behavior for renderers invoked without extension configuration. */
export const PREVIEW_MUTATION_SETTINGS: MutationSettings = {
    ...DEFAULT_MUTATION_SETTINGS,
    defaultView: "preview",
};

/** Returns whether a completed mutation should render every available row. */
export function showsFullMutation(settings: MutationSettings, expanded: boolean): boolean {
    return expanded || settings.defaultView === "full";
}
