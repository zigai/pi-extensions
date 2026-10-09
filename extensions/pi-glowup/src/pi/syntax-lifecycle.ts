import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type GlowupConfig } from "../config/normalize.ts";
import { DebugFileLogger, type DebugLogFields } from "../diagnostics/logger.ts";
import { refreshSyntaxHighlighting } from "../rendering/syntax/highlighter.ts";
import { refreshToolRows } from "./session.ts";

const SYNTAX_WARMUP_DELAY_MS = 5_000;

type SyntaxHighlightingLifecycleOptions = {
    readonly config: GlowupConfig;
    readonly cwd: string | undefined;
    readonly reportWarning: (message: string) => void;
};

async function loadSyntaxHighlighting(options: SyntaxHighlightingLifecycleOptions): Promise<void> {
    try {
        const projectLanguageDetection =
            options.cwd === undefined
                ? { enabled: options.config.syntax.projectLanguageDetection.enabled }
                : {
                      enabled: options.config.syntax.projectLanguageDetection.enabled,
                      cwd: options.cwd,
                  };

        await refreshSyntaxHighlighting(process.env, {
            preloadLanguages: options.config.syntax.preloadLanguages,
            projectLanguageDetection,
            reportWarning: options.reportWarning,
        });
    } catch (cause: unknown) {
        options.reportWarning(`[pi-glowup] Syntax preload failed: ${errorMessage(cause)}`);
    }
}

function errorMessage(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

export function createSyntaxLifecycle(options: {
    readonly generation: () => number;
    readonly debugLogger: DebugFileLogger;
    readonly diagnosticSnapshot: () => DebugLogFields;
    readonly reportWarning: (message: string) => void;
}) {
    const { debugLogger, diagnosticSnapshot, reportWarning, generation } = options;
    const pendingSyntaxTasks = new Set<Promise<void>>();
    let pendingSyntaxStart:
        | {
              readonly generation: number;
              readonly options: SyntaxHighlightingLifecycleOptions;
              readonly context: ExtensionContext;
          }
        | undefined;
    let syntaxTimer: NodeJS.Timeout | undefined;

    const startPendingSyntaxHighlighting = (): void => {
        const pending = pendingSyntaxStart;
        if (pending === undefined) return;

        pendingSyntaxStart = undefined;

        if (syntaxTimer !== undefined) {
            clearTimeout(syntaxTimer);
            syntaxTimer = undefined;
        }

        const syntaxTask = loadSyntaxHighlighting(pending.options);
        pendingSyntaxTasks.add(syntaxTask);
        void syntaxTask
            .then(() => {
                pendingSyntaxTasks.delete(syntaxTask);

                if (generation() !== pending.generation) return;

                refreshToolRows(pending.context);
                debugLogger.record("session_start", () => ({
                    phase: "after_syntax",
                    ...diagnosticSnapshot(),
                }));
            })
            .catch((cause: unknown) => {
                pendingSyntaxTasks.delete(syntaxTask);
                reportWarning(`[pi-glowup] Syntax preload failed: ${errorMessage(cause)}`);
            });
    };

    const scheduleSyntaxHighlighting = (
        options: SyntaxHighlightingLifecycleOptions,
        context: ExtensionContext,
    ): void => {
        if (syntaxTimer !== undefined) clearTimeout(syntaxTimer);

        pendingSyntaxStart = {
            generation: generation(),
            options,
            context,
        };
        syntaxTimer = setTimeout(startPendingSyntaxHighlighting, SYNTAX_WARMUP_DELAY_MS);
        syntaxTimer.unref();
    };

    function cancel(): void {
        pendingSyntaxStart = undefined;

        if (syntaxTimer !== undefined) {
            clearTimeout(syntaxTimer);
            syntaxTimer = undefined;
        }
    }

    async function settle(): Promise<void> {
        await Promise.allSettled(pendingSyntaxTasks);
        pendingSyntaxTasks.clear();
    }

    return { startPendingSyntaxHighlighting, scheduleSyntaxHighlighting, cancel, settle };
}
