import { extname } from "node:path";
import { reportExtensionDiagnostic } from "@zigai/pi-extension-internals";
import type {
    ScriptBlockFormatter,
    ScriptBlockFormatterInput,
    ScriptBlockFormatterOptions,
} from "../../tools/built-in/bash/formatter.ts";
import { formatEmbeddedHeredocs } from "./embedded-heredocs.ts";
import { formatEmbeddedFilterPrograms, hasFormattableFilterProgram } from "./embedded-filters.ts";
import { formatCodeUnit } from "./code-unit.ts";
import { MAX_SCRIPT_PREVIEW_ENTRIES } from "../../tools/built-in/bash/preview-store.ts";
import { createStatementService } from "./statement-service.ts";
import type { StatementUnit } from "./statement-worker.ts";
import {
    recordRenderError,
    type ScriptFormatDiagnostics,
} from "../../diagnostics/render-events.ts";

export type CodeStreamingMode = "token" | "statement" | "block";

export type CodeStreamInput = {
    readonly key: string;
    readonly source: string;
    readonly language?: string | undefined;
    readonly path?: string | undefined;
    readonly complete: boolean;
    readonly mode: CodeStreamingMode;
    readonly formatter?: ScriptBlockFormatter | undefined;
    readonly targetWidth?: number | undefined;
    readonly invalidate?: (() => void) | undefined;
    readonly signal?: AbortSignal | undefined;

    /** Owning tool call for diagnostics; statement and block events carry it. */
    readonly toolCallId?: string | undefined;

    /** Overrides the diagnostics context derived from `toolCallId`. */
    readonly diagnostics?: ScriptFormatDiagnostics | undefined;
};

export type CodeStreamStore = {
    get(input: CodeStreamInput): string;
    ready(key: string): boolean;
    clear(): void;
    dispose(): Promise<void>;
    settled(): Promise<void>;

    formatEmbedded(
        input: ScriptBlockFormatterInput,
        formatter: ScriptBlockFormatter | undefined,
        options?: ScriptBlockFormatterOptions,
    ): Promise<string>;
};

type Entry = {
    input: CodeStreamInput;
    language: string;
    display: string;
    consumed: number;
    controller: AbortController;
    indents: Map<number, string>;
    atomic: boolean;
    done: boolean;
    lastKind: string;
    running: boolean;
};

function sourceAborted(input: CodeStreamInput): boolean {
    return input.signal?.aborted === true;
}

function languageFor(input: CodeStreamInput): string {
    let value = input.language;
    if (value === undefined || value.trim().length === 0) value = extname(input.path ?? "");
    value = value.trim().toLowerCase().replace(/^\./u, "");
    if (["js", "javascript", "jsx", "mjs", "cjs", "node", "nodejs"].includes(value))
        return "javascript";
    if (["ts", "typescript", "mts", "cts"].includes(value)) return "typescript";
    if (value === "tsx") return "tsx";
    if (["py", "python", "python3", "pyw"].includes(value)) return "python";
    if (["sh", "bash", "shell", "shellscript"].includes(value)) return "bash";
    return value;
}

function embeddedOptions(input: CodeStreamInput, signal: AbortSignal): ScriptBlockFormatterOptions {
    if (input.toolCallId === undefined) return { signal };

    return { signal, diagnostics: { toolCallId: input.toolCallId } };
}

/** Display-only snapshots. No formatted text is written back to tool input or model history. */
export function createCodeStreamStore(): CodeStreamStore {
    const entries = new Map<string, Entry>();
    const jobs = new Set<Promise<void>>();
    const parser = createStatementService();
    let disposed = false;
    let disposal: Promise<void> | undefined;
    let externalController = new AbortController();

    async function formatEmbedded(
        input: ScriptBlockFormatterInput,
        formatter: ScriptBlockFormatter | undefined,
        options: ScriptBlockFormatterOptions = {},
    ): Promise<string> {
        if (disposed || formatter === undefined) return input.code;
        if (!input.code.includes("<<") && !hasFormattableFilterProgram(input.code, formatter))
            return input.code;

        let signal = externalController.signal;
        if (options.signal !== undefined) signal = AbortSignal.any([signal, options.signal]);

        const operation = formatEmbeddedHeredocs(input, formatter, parser, {
            ...options,
            signal,
        }).then(async (code) =>
            formatEmbeddedFilterPrograms({ ...input, code }, formatter, { ...options, signal }),
        );
        const job = operation.then(
            () => {},
            () => {},
        );
        jobs.add(job);
        void job.then(() => jobs.delete(job));

        return operation;
    }

    function current(entry: Entry): boolean {
        return (
            !disposed && !entry.controller.signal.aborted && entries.get(entry.input.key) === entry
        );
    }

    function publish(entry: Entry, display: string, consumed: number, done = false): void {
        if (!current(entry)) return;

        const readyChanged = entry.done !== done;

        entry.consumed = consumed;
        entry.done = done;
        if (entry.display === display && !readyChanged) return;

        entry.display = display;

        try {
            entry.input.invalidate?.();
        } catch (cause: unknown) {
            // A renderer disappearing must not turn a completed unit into a failed job.
            recordRenderError("code-stream.invalidate", cause, entry.input.toolCallId);
        }
    }

    async function run(entry: Entry, initialDisplay: string): Promise<void> {
        const input = entry.input;
        const signal = entry.controller.signal;
        if (input.mode === "block") {
            if (!input.complete) return;

            const unit: StatementUnit = {
                start: 0,
                end: input.source.length,
                format: true,
                indent: "",
                kind: "block",
            };
            let formatted = await formatCodeUnit(input, entry.language, unit, signal, "");
            if (entry.language === "bash")
                formatted = {
                    ...formatted,
                    text: await formatEmbedded(
                        {
                            label: "Bash",
                            language: "bash",
                            code: formatted.text,
                            ...(input.targetWidth !== undefined && {
                                targetWidth: input.targetWidth,
                            }),
                        },
                        input.formatter,
                        embeddedOptions(input, signal),
                    ),
                };

            if (input.targetWidth !== entry.input.targetWidth) return;

            publish(entry, formatted.text, input.source.length, true);

            return;
        }

        const response = await parser.parse(input.source, entry.language, input.complete, signal);

        if (!current(entry)) return;

        if (response === undefined || "error" in response) {
            // No parser means no trustworthy statement boundaries. Never send the growing
            // script to a formatter as a fallback; the service already emitted a diagnostic.
            if (input.complete) publish(entry, input.source, input.source.length, true);
            return;
        }

        // Syntax recovery is a content fallback, not an extension failure. A
        // partial example or grammar mismatch must not raise session warnings
        // (again on every resize); the parser retains unformatted source spans.

        let display = initialDisplay;
        let consumed = entry.consumed;
        let lastKind = entry.lastKind;
        for (const unit of response.units) {
            if (unit.end <= consumed) continue;
            if (!current(entry)) return;

            let containerIndent: string | undefined;
            if (unit.container !== undefined) containerIndent = entry.indents.get(unit.container);

            let indent = containerIndent ?? unit.indent;
            if (unit.container === undefined && (unit.kind === "header" || unit.kind === "close"))
                indent = "";

            if (unit.start < consumed) {
                display += input.source.slice(consumed, unit.end);
            } else {
                let formatted = await formatCodeUnit(input, entry.language, unit, signal, indent);
                if (entry.language === "bash")
                    formatted = {
                        ...formatted,
                        text: await formatEmbedded(
                            {
                                label: "Bash",
                                language: "bash",
                                code: formatted.text,
                                ...(input.targetWidth !== undefined && {
                                    targetWidth: input.targetWidth,
                                }),
                            },
                            input.formatter,
                            embeddedOptions(input, signal),
                        ),
                    };

                if (!current(entry) || input.targetWidth !== entry.input.targetWidth) return;

                if (unit.body !== undefined && formatted.bodyIndent !== undefined)
                    entry.indents.set(unit.body, formatted.bodyIndent);

                let gap = input.source.slice(consumed, unit.start);
                const formattedLayout =
                    formatted.applied === true ||
                    containerIndent !== undefined ||
                    (unit.kind === "close" &&
                        unit.body !== undefined &&
                        entry.indents.has(unit.body));

                // An installed formatter may not support this language, or may
                // decline a unit. In that case preserve its lexical gaps rather
                // than turning an unformatted inline Python suite into invalid code.
                if (formattedLayout && unit.kind !== "structure") {
                    if (
                        unit.branch === true &&
                        ["javascript", "typescript", "tsx"].includes(entry.language) &&
                        display.endsWith("}")
                    )
                        gap = " ";
                    else if (
                        /^[\t \r\n]*$/u.test(gap) &&
                        (gap.includes("\n") ||
                            (lastKind === "header" && containerIndent !== undefined) ||
                            unit.kind === "close")
                    ) {
                        let newlines = gap.replace(/[^\n]/gu, "");
                        if (newlines.length === 0) newlines = "\n";
                        gap = newlines + indent;
                    } else if (gap.includes("\n")) gap = gap.replace(/[\t ]*$/u, "") + indent;
                }

                display += gap + formatted.text;
            }

            consumed = unit.end;
            lastKind = unit.kind;

            if (!entry.atomic) publish(entry, display, consumed);
        }

        entry.lastKind = lastKind;
        entry.atomic = false;
        publish(entry, display, consumed, input.complete && consumed >= input.source.length);
    }

    function launch(entry: Entry, display: string): void {
        entry.running = true;

        const job = (async (): Promise<void> => {
            try {
                let visible = display;

                while (current(entry)) {
                    const input = entry.input;
                    await run(entry, visible);

                    if (entry.input.targetWidth !== input.targetWidth) {
                        entry.consumed = 0;
                        entry.indents.clear();
                        entry.lastKind = "";
                        entry.atomic = true;
                        visible = "";
                        continue;
                    }

                    if (
                        entry.input.source === input.source &&
                        entry.input.complete === input.complete
                    )
                        return;

                    visible = entry.display;
                }
            } catch (cause: unknown) {
                if (!current(entry)) return;

                recordRenderError("code-stream.run", cause, entry.input.toolCallId);

                reportExtensionDiagnostic(
                    "[pi-glowup] Code stream processing failed; unfinished code is held until completion.",
                );

                if (entry.input.complete)
                    publish(entry, entry.input.source, entry.input.source.length, true);
            } finally {
                // Publish idle in the same continuation as the final input check.
                // Otherwise a late update can see running=true after the loop exited.
                entry.running = false;
            }
        })();

        jobs.add(job);
        void job.then(() => jobs.delete(job));
    }

    function clear(): void {
        externalController.abort();
        externalController = new AbortController();

        for (const entry of entries.values()) entry.controller.abort();
        entries.clear();
    }

    async function settled(): Promise<void> {
        while (jobs.size > 0) await Promise.all(jobs);
    }

    return {
        get(input): string {
            if (input.toolCallId !== undefined && input.complete && input.mode === "statement")
                input = { ...input, mode: "block" };

            if (disposed || sourceAborted(input)) return "";

            const previous = entries.get(input.key);
            if (input.mode === "token") {
                previous?.controller.abort();
                entries.delete(input.key);
                return input.source;
            }

            const language = languageFor(input);
            if (
                previous !== undefined &&
                previous.running &&
                previous.input.mode === input.mode &&
                previous.input.formatter === input.formatter &&
                previous.input.signal === input.signal &&
                previous.language === language &&
                previous.input.path === input.path &&
                previous.input.source === input.source &&
                previous.input.complete === input.complete
            ) {
                // Width updates replace the pending target, not the running formatter.
                // Its last published display remains visible until the latest width settles.
                previous.input = input;
                return previous.display;
            }

            const reusable =
                previous !== undefined &&
                previous.input.mode === input.mode &&
                previous.input.formatter === input.formatter &&
                previous.input.signal === input.signal &&
                previous.input.targetWidth === input.targetWidth &&
                previous.language === language &&
                previous.input.path === input.path;
            if (
                reusable &&
                previous.input.source === input.source &&
                previous.input.complete === input.complete
            ) {
                previous.input = input;
                return previous.display;
            }

            if (
                reusable &&
                !previous.input.complete &&
                input.source.startsWith(previous.input.source)
            ) {
                previous.input = input;
                entries.delete(input.key);
                entries.set(input.key, previous);

                if (!previous.running) launch(previous, previous.display);
                return previous.display;
            }

            previous?.controller.abort();

            let display = "";
            let atomic = false;
            if (
                previous !== undefined &&
                !reusable &&
                input.source.startsWith(previous.input.source) &&
                (input.source === previous.input.source || !previous.input.complete) &&
                previous.language === language &&
                (previous.input.mode === input.mode || input.complete)
            ) {
                // A resize/profile change rebuilds from individual units, retaining the old
                // ready display until replacement units become available.
                display = previous.display;
                atomic = true;
            }

            const entry: Entry = {
                input,
                language,
                display,
                consumed: 0,
                controller: new AbortController(),
                indents: new Map(),
                atomic,
                done: false,
                lastKind: "",
                running: false,
            };

            entries.delete(input.key);
            entries.set(input.key, entry);

            const retire = (): void => {
                if (entries.get(entry.input.key) === entry) entries.delete(entry.input.key);
                entry.controller.abort();
            };

            input.signal?.addEventListener("abort", retire, {
                once: true,
                signal: entry.controller.signal,
            });

            // An earlier owner's cancellation may synchronously retire this source
            // while get() replaces its entry. Do not miss an already-fired abort.
            if (sourceAborted(input)) {
                retire();
                return "";
            }

            while (entries.size > MAX_SCRIPT_PREVIEW_ENTRIES) {
                const oldest = entries.keys().next().value;
                if (oldest === undefined) break;

                entries.get(oldest)?.controller.abort();
                entries.delete(oldest);
            }

            launch(entry, "");

            return entry.display;
        },
        formatEmbedded,
        ready(key): boolean {
            const entry = entries.get(key);
            return (
                entry !== undefined &&
                entry.input.complete &&
                entry.done &&
                entry.consumed >= entry.input.source.length
            );
        },
        clear,
        settled,
        async dispose(): Promise<void> {
            if (disposal !== undefined) return disposal;

            disposed = true;
            clear();
            disposal = Promise.all([parser.dispose(), settled()]).then(() => {});
            return disposal;
        },
    };
}
