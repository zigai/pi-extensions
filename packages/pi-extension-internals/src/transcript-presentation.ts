/** Source containers may implement this no-argument method to prepare their original ordered rows. */
export const TRANSCRIPT_PRESENTATION = Symbol.for(
    "zigai.pi-extension-internals.transcript-presentation.v1",
);

export type TranscriptPresentationSource = {
    readonly children: readonly unknown[];
    [TRANSCRIPT_PRESENTATION]?(): void;
};

/** Runs an optional source-owned presentation hook without rendering the source container. */
export function prepareTranscriptPresentation(source: TranscriptPresentationSource): void {
    source[TRANSCRIPT_PRESENTATION]?.();
}
