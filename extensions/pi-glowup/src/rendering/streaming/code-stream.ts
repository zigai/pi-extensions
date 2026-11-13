import { extname } from "node:path";
import { reportExtensionDiagnostic } from "@zigai/pi-extension-internals";
import type {
    ScriptBlockFormatter,
    ScriptBlockFormatterInput,
    ScriptBlockFormatterOptions,
} from "../../tools/built-in/bash/formatter.ts";
import { formatEmbeddedPrograms } from "./embedded-programs.ts";
import { formatCodeUnit } from "./code-unit.ts";
import { MAX_SCRIPT_PREVIEW_ENTRIES } from "../../tools/built-in/bash/preview-store.ts";
import { createStatementService } from "./statement-service.ts";
import type { EmbeddedProgram } from "../../tools/built-in/bash/embedded-programs.ts";
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

    /** True while the display covers the whole complete source, even during a relayout. */
    showsCompleteSource(key: string): boolean;
    clear(): void;
    dispose(): Promise<void>;
    settled(): Promise<void>;

    formatEmbedded(
        input: ScriptBlockFormatterInput,
        formatter: ScriptBlockFormatter | undefined,
        options?: ScriptBlockFormatterOptions,
    ): Promise<string>;
};

type EntryPass = { readonly input: CodeStreamInput };

type EntryExecution =
    | { readonly kind: "idle" }
    | { readonly kind: "running"; readonly pass: EntryPass }
    | { readonly kind: "retired" };

// Source completion belongs to input. Readiness belongs to this display revision;
// a completed source can still be streaming or awaiting an atomic replacement.
type EntryPublication =
    | { readonly kind: "streaming"; readonly display: string }
    | { readonly kind: "replacing"; readonly display: string; readonly revealed: boolean }
    | { readonly kind: "ready"; readonly display: string };

type EntryProgress = {
    consumed: number;
    indents: Map<number, string>;
    lastKind: string;
};

type Entry = {
    input: CodeStreamInput;
    language: string;
    controller: AbortController;
    execution: EntryExecution;
    publication: EntryPublication;
    progress: EntryProgress;
};

type EntryUpdate =
    | { readonly kind: "refresh" }
    | { readonly kind: "resize" }
    | { readonly kind: "append" }
    | { readonly kind: "rebuild" }
    | { readonly kind: "rewrite" }
    | { readonly kind: "truncate" };

function emptyProgress(): EntryProgress {
    return { consumed: 0, indents: new Map(), lastKind: "" };
}

function updateFor(entry: Entry, input: CodeStreamInput, language: string): EntryUpdate {
    const previous = entry.input;
    const sameProfile =
        previous.mode === input.mode &&
        previous.formatter === input.formatter &&
        previous.signal === input.signal &&
        entry.language === language &&
        previous.path === input.path;
    const sameSource = previous.source === input.source && previous.complete === input.complete;

    if (sameProfile && sameSource) {
        if (previous.targetWidth === input.targetWidth) return { kind: "refresh" };

        return { kind: "resize" };
    }

    if (
        sameProfile &&
        previous.targetWidth === input.targetWidth &&
        !previous.complete &&
        input.source.startsWith(previous.source)
    )
        return { kind: "append" };

    if (
        (!sameProfile || previous.targetWidth !== input.targetWidth) &&
        input.source.startsWith(previous.source) &&
        (input.source === previous.source || !previous.complete) &&
        entry.language === language &&
        (previous.mode === input.mode || input.complete)
    )
        return { kind: "rebuild" };

    if (previous.source.startsWith(input.source) && input.source.length < previous.source.length)
        return { kind: "truncate" };

    return { kind: "rewrite" };
}

// A finished display stays revealed while the same complete source is laid out again,
// for example at a new width, so surrounding content does not disappear meanwhile.
function replacementOf(entry: Entry, input: CodeStreamInput): EntryPublication {
    const publication = entry.publication;
    let revealed = publication.kind === "ready";
    if (publication.kind === "replacing") revealed = publication.revealed;

    return {
        kind: "replacing",
        display: publication.display,
        revealed:
            revealed &&
            entry.input.complete &&
            input.complete &&
            entry.input.source === input.source,
    };
}

function requestReplacement(entry: Entry, input: CodeStreamInput): void {
    entry.publication = replacementOf(entry, input);
    entry.input = input;
}

function requestAppend(entry: Entry, input: CodeStreamInput): void {
    entry.input = input;
    if (entry.publication.kind === "ready")
        entry.publication = { kind: "streaming", display: entry.publication.display };
}

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
    if (input.toolCallId === undefined && input.diagnostics === undefined) return { signal };

    return {
        signal,
        diagnostics: {
            ...(input.toolCallId !== undefined && { toolCallId: input.toolCallId }),
            ...input.diagnostics,
        },
    };
}

function programsForUnit(
    programs: readonly EmbeddedProgram[],
    start: number,
    end: number,
): EmbeddedProgram[] {
    const included = new Map<EmbeddedProgram, EmbeddedProgram>();
    for (const program of programs) {
        if (program.start < start || program.end > end) continue;

        if (program.parent !== undefined) {
            const parent = included.get(program.parent);
            if (parent !== undefined) included.set(program, { ...program, parent });
        } else {
            included.set(program, {
                ...program,
                localStart: program.localStart - start,
                localEnd: program.localEnd - start,
            });
        }
    }

    return [...included.values()];
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

        let signal = externalController.signal;
        if (options.signal !== undefined) signal = AbortSignal.any([signal, options.signal]);

        const operation = (async () => {
            let programs = options.programs;
            programs ??= await parser.extract(input.code, signal);
            if (programs === undefined || signal.aborted) return input.code;
            return formatEmbeddedPrograms(input, formatter, parser, programs, {
                ...options,
                signal,
            });
        })();
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
            !disposed &&
            entry.execution.kind !== "retired" &&
            !entry.controller.signal.aborted &&
            entries.get(entry.input.key) === entry
        );
    }

    function currentPass(entry: Entry, pass: EntryPass): boolean {
        return (
            current(entry) &&
            entry.execution.kind === "running" &&
            entry.execution.pass === pass &&
            pass.input.targetWidth === entry.input.targetWidth
        );
    }

    function retire(entry: Entry): void {
        entry.execution = { kind: "retired" };
        entry.controller.abort();
    }

    function publish(
        entry: Entry,
        pass: EntryPass,
        display: string,
        consumed: number,
        finished = false,
    ): void {
        if (!currentPass(entry, pass)) return;

        const previous = entry.publication;
        const ready =
            finished &&
            entry.input.complete &&
            pass.input.complete &&
            pass.input.source === entry.input.source &&
            consumed >= entry.input.source.length;

        entry.progress.consumed = consumed;
        if (ready) entry.publication = { kind: "ready", display };
        else entry.publication = { kind: "streaming", display };

        if (previous.display === display && (previous.kind === "ready") === ready) return;

        try {
            entry.input.invalidate?.();
        } catch (cause: unknown) {
            // A renderer disappearing must not turn a completed unit into a failed job.
            recordRenderError("code-stream.invalidate", cause, entry.input.toolCallId);
        }
    }

    async function run(entry: Entry, pass: EntryPass, initialDisplay: string): Promise<void> {
        const input = pass.input;
        const signal = entry.controller.signal;
        if (input.mode === "block") {
            if (!input.complete) return;

            let source = input.source;
            if (entry.language === "bash")
                source = await formatEmbedded(
                    {
                        label: "Bash",
                        language: "bash",
                        code: input.source,
                        ...(input.targetWidth !== undefined && { targetWidth: input.targetWidth }),
                    },
                    input.formatter,
                    embeddedOptions(input, signal),
                );

            const unit: StatementUnit = {
                start: 0,
                end: source.length,
                format: true,
                indent: "",
                kind: "block",
            };
            const formatted = await formatCodeUnit(
                {
                    ...input,
                    source,
                    diagnostics: { ...input.diagnostics, segmentCode: input.source },
                },
                entry.language,
                unit,
                signal,
                "",
            );

            if (input.targetWidth !== entry.input.targetWidth) return;

            publish(entry, pass, formatted.text, input.source.length, true);

            return;
        }

        const response = await parser.parse(input.source, entry.language, input.complete, signal);

        if (!currentPass(entry, pass)) return;

        if (response === undefined || "error" in response) {
            // No parser means no trustworthy statement boundaries. Never send the growing
            // script to a formatter as a fallback; the service already emitted a diagnostic.
            if (input.complete) publish(entry, pass, input.source, input.source.length, true);
            return;
        }

        // Syntax recovery is a content fallback, not an extension failure. A
        // partial example or grammar mismatch must not raise session warnings
        // (again on every resize); the parser retains unformatted source spans.

        const programs = response.programs ?? [];
        let display = initialDisplay;
        let consumed = entry.progress.consumed;
        let lastKind = entry.progress.lastKind;
        for (const unit of response.units) {
            if (unit.end <= consumed) continue;
            if (!currentPass(entry, pass)) return;

            let containerIndent: string | undefined;
            if (unit.container !== undefined)
                containerIndent = entry.progress.indents.get(unit.container);

            let indent = containerIndent ?? unit.indent;
            if (unit.container === undefined && (unit.kind === "header" || unit.kind === "close"))
                indent = "";

            if (unit.start < consumed) {
                display += input.source.slice(consumed, unit.end);
            } else {
                let formatted;
                if (entry.language === "bash") {
                    const original = input.source.slice(unit.start, unit.end);
                    const source = await formatEmbedded(
                        {
                            label: "Bash",
                            language: "bash",
                            code: original,
                            ...(input.targetWidth !== undefined && {
                                targetWidth: input.targetWidth,
                            }),
                        },
                        input.formatter,
                        {
                            ...embeddedOptions(input, signal),
                            programs: programsForUnit(programs, unit.start, unit.end),
                        },
                    );
                    const parsed = await parser.parse(source, "bash", true, signal);
                    if (parsed === undefined || "error" in parsed || parsed.malformed) {
                        formatted = { text: original };
                    } else {
                        const literals = parsed.units.flatMap((part) => part.literals ?? []);

                        formatted = await formatCodeUnit(
                            {
                                ...input,
                                source,
                                diagnostics: { ...input.diagnostics, segmentCode: original },
                            },
                            entry.language,
                            { ...unit, start: 0, end: source.length, literals },
                            signal,
                            indent,
                        );
                    }
                } else
                    formatted = await formatCodeUnit(input, entry.language, unit, signal, indent);

                if (!currentPass(entry, pass)) return;

                if (unit.body !== undefined && formatted.bodyIndent !== undefined)
                    entry.progress.indents.set(unit.body, formatted.bodyIndent);

                let gap = input.source.slice(consumed, unit.start);
                const formattedLayout =
                    formatted.applied === true ||
                    containerIndent !== undefined ||
                    (unit.kind === "close" &&
                        unit.body !== undefined &&
                        entry.progress.indents.has(unit.body));

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
                            (lastKind !== "header" &&
                                ["javascript", "typescript", "tsx"].includes(entry.language) &&
                                display.endsWith(";")) ||
                            unit.kind === "close")
                    ) {
                        let newlines = gap.replace(/[^\n]/gu, "");
                        if (newlines.length === 0) newlines = "\n";
                        gap = newlines + indent;
                    } else if (/\n[\t ]*$/u.test(gap)) {
                        // Gaps can include lexical prefixes such as `export `.
                        // Only replace indentation on an otherwise empty final row.
                        gap = gap.replace(/[\t ]*$/u, "") + indent;
                    }
                }

                display += gap + formatted.text;
            }

            consumed = unit.end;
            lastKind = unit.kind;

            if (entry.publication.kind !== "replacing") publish(entry, pass, display, consumed);
        }

        entry.progress.lastKind = lastKind;
        publish(entry, pass, display, consumed, input.complete && consumed >= input.source.length);
    }

    function launch(entry: Entry, display: string): void {
        if (entry.execution.kind !== "idle") return;

        const job = (async (): Promise<void> => {
            let visible = display;

            try {
                while (current(entry)) {
                    const pass: EntryPass = { input: entry.input };
                    entry.execution = { kind: "running", pass };

                    try {
                        await run(entry, pass, visible);
                    } catch (cause: unknown) {
                        if (!current(entry)) return;

                        recordRenderError("code-stream.run", cause, pass.input.toolCallId);
                        reportExtensionDiagnostic(
                            "[pi-glowup] Code stream processing failed; unfinished code is held until completion.",
                        );

                        if (pass.input.complete)
                            publish(entry, pass, pass.input.source, pass.input.source.length, true);
                    }

                    if (!current(entry)) return;

                    if (entry.input.targetWidth !== pass.input.targetWidth) {
                        // The old pass owns its progress until it returns. Only then
                        // reset indentation/boundaries and build the latest width offscreen.
                        entry.progress = emptyProgress();
                        requestReplacement(entry, entry.input);
                        visible = "";
                        continue;
                    }

                    if (
                        entry.input.source === pass.input.source &&
                        entry.input.complete === pass.input.complete
                    )
                        return;

                    visible = entry.publication.display;
                }
            } finally {
                // Idle and the final input check share one continuation, so an
                // update cannot be stranded behind a runner that already exited.
                if (entry.execution.kind !== "retired") entry.execution = { kind: "idle" };
            }
        })();

        jobs.add(job);
        void job.then(() => jobs.delete(job));
    }

    function clear(): void {
        externalController.abort();
        externalController = new AbortController();

        for (const entry of entries.values()) retire(entry);
        entries.clear();
    }

    async function settled(): Promise<void> {
        while (jobs.size > 0) await Promise.all(jobs);
    }

    function ready(key: string): boolean {
        const entry = entries.get(key);

        return (
            entry !== undefined &&
            entry.input.complete &&
            entry.publication.kind === "ready" &&
            entry.progress.consumed >= entry.input.source.length
        );
    }

    return {
        get(input): string {
            if (input.toolCallId !== undefined && input.complete && input.mode === "statement")
                input = { ...input, mode: "block" };

            if (disposed || sourceAborted(input)) return "";

            const previous = entries.get(input.key);
            if (input.mode === "token") {
                if (previous !== undefined) retire(previous);
                entries.delete(input.key);

                return input.source;
            }

            const language = languageFor(input);
            let publication: EntryPublication = { kind: "streaming", display: "" };
            if (previous !== undefined) {
                const update = updateFor(previous, input, language);
                switch (update.kind) {
                    case "refresh":
                        previous.input = input;
                        return previous.publication.display;
                    case "append":
                        requestAppend(previous, input);
                        entries.delete(input.key);
                        entries.set(input.key, previous);
                        launch(previous, previous.publication.display);

                        return previous.publication.display;
                    case "resize":
                        if (previous.execution.kind === "running") {
                            // Coalesce targets without aborting the formatter. The
                            // in-flight revision may finish but can no longer publish.
                            requestReplacement(previous, input);
                            return previous.publication.display;
                        }

                        publication = replacementOf(previous, input);
                        break;
                    case "rebuild":
                        publication = replacementOf(previous, input);
                        break;
                    case "rewrite":
                    case "truncate":
                        // Rewritten source has no reusable boundaries or indentation.
                        break;
                }

                retire(previous);
            }

            const entry: Entry = {
                input,
                language,
                controller: new AbortController(),
                execution: { kind: "idle" },
                publication,
                progress: emptyProgress(),
            };

            entries.delete(input.key);
            entries.set(input.key, entry);

            const retireSource = (): void => {
                if (entries.get(entry.input.key) === entry) entries.delete(entry.input.key);
                retire(entry);
            };

            input.signal?.addEventListener("abort", retireSource, {
                once: true,
                signal: entry.controller.signal,
            });

            // An earlier owner's cancellation may synchronously retire this source
            // while get() replaces its entry. Do not miss an already-fired abort.
            if (sourceAborted(input)) {
                retireSource();
                return "";
            }

            while (entries.size > MAX_SCRIPT_PREVIEW_ENTRIES) {
                const oldest = entries.keys().next().value;
                if (oldest === undefined) break;

                const evicted = entries.get(oldest);
                if (evicted !== undefined) retire(evicted);
                entries.delete(oldest);
            }

            launch(entry, "");

            return entry.publication.display;
        },
        formatEmbedded,
        ready,
        showsCompleteSource(key): boolean {
            const entry = entries.get(key);
            if (entry?.publication.kind === "replacing") return entry.publication.revealed;

            return ready(key);
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
