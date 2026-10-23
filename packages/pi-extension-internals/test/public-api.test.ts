import * as internals from "@zigai/pi-extension-internals";
import { expect, test } from "vitest";

test("package root exposes only supported runtime capabilities", () => {
    expect(Object.keys(internals).sort()).toEqual([
        "PHYSICAL_MODEL_ID",
        "TRANSCRIPT_PRESENTATION",
        "bindExtensionDiagnostics",
        "installKeyedLinkedMethodPatch",
        "installLinkedMethodPatch",
        "installLinkedRenderPatch",
        "loadPiInternalModule",
        "loadPiRuntimeModule",
        "prepareTranscriptPresentation",
        "registerEditorBackend",
        "registerEditorEnhancer",
        "registerExtensionDiagnostics",
        "reportExtensionDiagnostic",
        "warnPiInternalPatchUnavailable",
    ]);

    expect("resolvePiInternalModuleUrl" in internals).toBe(false);
});
