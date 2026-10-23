import { bindExtensionDiagnostics } from "@zigai/pi-extension-internals";

export type CapturedDiagnostic = {
    readonly message: string;
    readonly severity: "info" | "warning" | "error";
};

export async function captureDiagnostics(
    run: () => void | Promise<void>,
): Promise<CapturedDiagnostic[]> {
    const diagnostics: CapturedDiagnostic[] = [];
    const binding = bindExtensionDiagnostics({
        hasUI: true,
        ui: {
            notify(message, severity = "warning"): void {
                diagnostics.push({ message, severity });
            },
        },
    });

    try {
        await run();
    } finally {
        binding.dispose();
    }

    return diagnostics;
}
