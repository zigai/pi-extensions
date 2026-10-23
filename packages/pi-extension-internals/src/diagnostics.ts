import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";

export type ExtensionDiagnosticSeverity = NonNullable<
    Parameters<ExtensionContext["ui"]["notify"]>[1]
>;

export type ExtensionDiagnosticContext =
    | { readonly hasUI: false }
    | (Pick<ExtensionContext, "hasUI"> & {
          readonly ui: Pick<ExtensionContext["ui"], "notify">;
      });

export type ExtensionDiagnosticsApi = {
    on(
        event: "session_start",
        handler: (event: SessionStartEvent, context: ExtensionDiagnosticContext) => void,
    ): void;
    on(event: "session_shutdown", handler: () => void): void;
};

type Diagnostic = {
    readonly message: string;
    readonly severity: ExtensionDiagnosticSeverity;
};

type DiagnosticSink =
    | { readonly hasUI: false }
    | {
          readonly hasUI: true;
          readonly notify: (message: string, severity: ExtensionDiagnosticSeverity) => void;
      };

type DiagnosticRegistry = {
    readonly version: number;
    readonly sinks: Map<symbol, DiagnosticSink>;
    readonly pending: Diagnostic[];
    readonly registered: WeakSet<ExtensionDiagnosticsApi>;
    delivering: boolean;
};

const DIAGNOSTICS = Symbol.for("zigai.pi-extension-internals.diagnostics");

function registry(): DiagnosticRegistry {
    const state: typeof globalThis & { [DIAGNOSTICS]?: DiagnosticRegistry } = globalThis;
    state[DIAGNOSTICS] ??= {
        version: 1,
        sinks: new Map(),
        pending: [],
        registered: new WeakSet(),
        delivering: false,
    };
    const current = state[DIAGNOSTICS];
    if (current.version !== 1) throw new Error("Unsupported extension diagnostic protocol version");
    return current;
}

function createSink(context: ExtensionDiagnosticContext): DiagnosticSink {
    if (!context.hasUI) return { hasUI: false };

    const ui = context.ui;
    return { hasUI: true, notify: ui.notify.bind(ui) };
}

function activeSink(context?: ExtensionDiagnosticContext): DiagnosticSink | undefined {
    let latest: DiagnosticSink | undefined;
    let latestUI: DiagnosticSink | undefined;
    for (const sink of registry().sinks.values()) {
        latest = sink;

        if (sink.hasUI) latestUI = sink;
    }

    if (context === undefined) return latestUI ?? latest;
    if (!context.hasUI && latestUI !== undefined) return latestUI;

    return createSink(context);
}

function deliver(diagnostic: Diagnostic, sink: DiagnosticSink): boolean {
    if (!sink.hasUI) {
        process.stderr.write(`${diagnostic.message}\n`);
        return true;
    }

    try {
        sink.notify(diagnostic.message, diagnostic.severity);
        return true;
    } catch {
        return false;
    }
}

function drain(context?: ExtensionDiagnosticContext): void {
    const state = registry();
    if (state.delivering) return;

    state.delivering = true;

    try {
        for (;;) {
            const diagnostic = state.pending.at(0);
            const sink = activeSink(context);
            if (diagnostic === undefined || sink === undefined || !deliver(diagnostic, sink))
                return;

            state.pending.shift();
        }
    } finally {
        state.delivering = false;
    }
}

/** Queues diagnostics until a session can deliver them; failed UI delivery never writes to the terminal. */
export function reportExtensionDiagnostic(
    message: string,
    severity: ExtensionDiagnosticSeverity = "warning",
    context?: ExtensionDiagnosticContext,
): void {
    registry().pending.push({ message, severity });
    drain(context);
}

export function bindExtensionDiagnostics(context: ExtensionDiagnosticContext) {
    const state = registry();
    const owner = Symbol();
    state.sinks.set(owner, createSink(context));
    drain();

    let disposed = false;

    return {
        dispose(): void {
            if (disposed) return;

            disposed = true;
            state.sinks.delete(owner);
        },
    };
}

export function registerExtensionDiagnostics(pi: ExtensionDiagnosticsApi): void {
    const state = registry();
    if (state.registered.has(pi)) return;

    state.registered.add(pi);

    let binding: ReturnType<typeof bindExtensionDiagnostics> | undefined;

    pi.on("session_start", (_event, ctx) => {
        binding?.dispose();
        binding = bindExtensionDiagnostics(ctx);
    });

    pi.on("session_shutdown", () => {
        binding?.dispose();
        binding = undefined;
    });
}
