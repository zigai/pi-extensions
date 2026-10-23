export { registerEditorEnhancer, registerEditorBackend } from "./editor-enhancer-registry.ts";
export { PHYSICAL_MODEL_ID } from "./model-identity.ts";
export {
    bindExtensionDiagnostics,
    registerExtensionDiagnostics,
    reportExtensionDiagnostic,
} from "./diagnostics.ts";
export type {
    ExtensionDiagnosticContext,
    ExtensionDiagnosticsApi,
    ExtensionDiagnosticSeverity,
} from "./diagnostics.ts";
export {
    TRANSCRIPT_PRESENTATION,
    prepareTranscriptPresentation,
} from "./transcript-presentation.ts";
export type { TranscriptPresentationSource } from "./transcript-presentation.ts";
export type {
    EditorBackendHandle,
    EditorEnhancer,
    EditorEnhancerContext,
    EditorEnhancerHandle,
    EditorFactory,
} from "./editor-enhancer-registry.ts";
export {
    installKeyedLinkedMethodPatch,
    installLinkedMethodPatch,
    installLinkedRenderPatch,
} from "./linked-method-patch.ts";
export type {
    KeyedLinkedMethodPatchHandle,
    LinkedMethod,
    LinkedMethodPatchHandle,
} from "./linked-method-patch.ts";
export {
    loadPiInternalModule,
    loadPiRuntimeModule,
    warnPiInternalPatchUnavailable,
} from "./pi-internal-import.ts";
export type { PiInternalModuleLoadOptions } from "./pi-internal-import.ts";
