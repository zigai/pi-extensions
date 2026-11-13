import type { GlowupCallLabels } from "@zigai/pi-glowup/protocol";

import {
    glowupWireArray,
    glowupWireNumber,
    glowupWireString,
    parseGlowupWireRecord,
    type GlowupWireRecord,
} from "../../glowup/wire.ts";
import {
    parseWebRunReferenceSections,
    parseWebRunSources,
    WEB_RUN_OMISSION,
    type WebRunReferenceSection,
} from "./output.ts";

type WebRunReference = {
    readonly command: "click" | "open";
    readonly refId: string;
    readonly linkId?: number | undefined;
};

type WebRunAction = {
    readonly labels: Required<GlowupCallLabels>;
    readonly target: string;
    readonly isUrl: boolean;

    /** Set when the action addresses a page by reference, so only its result names the page. */
    readonly reference?: WebRunReference | undefined;
};

export type WebRunPhase = "pending" | "running" | "complete";

type ActionSpec = {
    readonly key: string;
    readonly labels: Required<GlowupCallLabels>;
    readonly target: (record: GlowupWireRecord) => string | undefined;
    readonly reference?: (record: GlowupWireRecord) => WebRunReference | undefined;
};

function compact(value: string | undefined): string | undefined {
    const normalized = value?.replace(/\s+/gu, " ").trim();
    return normalized === "" ? undefined : normalized;
}

function field(record: GlowupWireRecord, key: string): string | undefined {
    return compact(glowupWireString(record, key));
}

function isTurnReference(value: string): boolean {
    return /^turn\d+[a-z]+\d+$/u.test(value);
}

function quoted(value: string | undefined): string | undefined {
    return value === undefined ? undefined : JSON.stringify(value);
}

const ACTIONS: readonly ActionSpec[] = [
    {
        key: "search_query",
        labels: {
            static: "Search the web for",
            running: "Searching the web for",
            completed: "Searched the web for",
            failed: "Web search failed for",
        },
        target: (record) => quoted(field(record, "q")),
    },
    {
        key: "image_query",
        labels: {
            static: "Search images for",
            running: "Searching images for",
            completed: "Searched images for",
            failed: "Image search failed for",
        },
        target: (record) => quoted(field(record, "q")),
    },
    {
        key: "open",
        labels: {
            static: "Open",
            running: "Opening",
            completed: "Opened",
            failed: "Failed to open",
        },
        target(record) {
            const ref = field(record, "ref_id");
            return ref !== undefined && isTurnReference(ref) ? "an earlier page" : ref;
        },
        reference(record) {
            const ref = field(record, "ref_id");
            return ref !== undefined && isTurnReference(ref)
                ? { command: "open", refId: ref }
                : undefined;
        },
    },
    {
        key: "click",
        labels: {
            static: "Follow",
            running: "Following",
            completed: "Followed",
            failed: "Failed to follow",
        },
        target(record) {
            const ref = field(record, "ref_id");
            const id = glowupWireNumber(record, "id");
            if (ref === undefined || id === undefined) return undefined;

            return `link ${id} on ${isTurnReference(ref) ? "an earlier page" : ref}`;
        },
        reference(record) {
            const ref = field(record, "ref_id");
            const id = glowupWireNumber(record, "id");
            return ref === undefined || id === undefined
                ? undefined
                : { command: "click", refId: ref, linkId: id };
        },
    },
    {
        key: "find",
        labels: {
            static: "Search page for",
            running: "Searching for",
            completed: "Searched for",
            failed: "Page search failed for",
        },
        target(record) {
            const ref = field(record, "ref_id");
            const pattern = quoted(field(record, "pattern"));
            return ref === undefined || pattern === undefined ? undefined : `${pattern} in ${ref}`;
        },
    },
    {
        key: "screenshot",
        labels: {
            static: "Capture",
            running: "Capturing",
            completed: "Captured",
            failed: "Failed to capture",
        },
        target(record) {
            const ref = field(record, "ref_id");
            const page = glowupWireNumber(record, "pageno");
            return ref === undefined || page === undefined ? undefined : `${ref} page ${page}`;
        },
    },
    {
        key: "finance",
        labels: {
            static: "Fetch market data for",
            running: "Fetching market data for",
            completed: "Fetched market data for",
            failed: "Failed to fetch market data for",
        },
        target: (record) => field(record, "ticker"),
    },
    {
        key: "weather",
        labels: {
            static: "Check weather for",
            running: "Checking weather for",
            completed: "Checked weather for",
            failed: "Failed to check weather for",
        },
        target: (record) => field(record, "location"),
    },
    {
        key: "sports",
        labels: {
            static: "Check sports",
            running: "Checking sports",
            completed: "Checked sports",
            failed: "Failed to check sports",
        },
        target: (record) =>
            [field(record, "league"), field(record, "fn"), field(record, "team")]
                .filter(Boolean)
                .join(" ") || undefined,
    },
    {
        key: "time",
        labels: {
            static: "Check time in",
            running: "Checking time in",
            completed: "Checked time in",
            failed: "Failed to check time in",
        },
        target: (record) => field(record, "utc_offset"),
    },
];

export const WEB_RUN_LABELS: Required<GlowupCallLabels> = {
    static: "Browse the web",
    running: "Browsing the web",
    completed: "Browsed the web",
    failed: "Web request failed",
};

/** Only actionable inputs: filters, output lengths, and result statistics stay out of the call. */
function webRunActions(args: GlowupWireRecord): WebRunAction[] {
    return ACTIONS.flatMap((action) =>
        (glowupWireArray(args, action.key) ?? []).flatMap((value) => {
            const record = parseGlowupWireRecord(value);
            const target = record === undefined ? undefined : action.target(record);
            if (record === undefined || target === undefined) return [];

            return [
                {
                    labels: action.labels,
                    target,
                    isUrl:
                        action.key !== "search_query" &&
                        action.key !== "image_query" &&
                        /https?:\/\//u.test(target),
                    reference: action.reference?.(record),
                },
            ];
        }),
    );
}

/** Rows for the call itself; a successful result renders the referenced pages instead. */
export function webRunCallActions(
    args: GlowupWireRecord,
    resultSucceeded: boolean,
): WebRunAction[] {
    const actions = webRunActions(args);

    return resultSucceeded ? actions.filter((action) => action.reference === undefined) : actions;
}

export type WebRunReferenceRow = {
    readonly label: string;
    readonly target: string;
    readonly isUrl: boolean;
    readonly error?: string | undefined;
};

const REFERENCE_RESULT_LABELS = {
    click: { completed: "Followed link to", failed: "Failed to follow link to" },
    open: { completed: "Opened", failed: "Failed to open" },
} as const;

/** One row per referenced page, in call order; actions without a matching section keep their call row. */
export function webRunReferenceRows(
    args: GlowupWireRecord,
    rawOutput: string,
): WebRunReferenceRow[] {
    const sections = parseWebRunReferenceSections(rawOutput);
    const used = new Set<WebRunReferenceSection>();

    return webRunActions(args).flatMap((action) => {
        const reference = action.reference;
        if (reference === undefined) return [];

        const section = sections.find(
            (candidate) =>
                !used.has(candidate) &&
                candidate.command === reference.command &&
                candidate.refId === reference.refId &&
                candidate.linkId === reference.linkId,
        );
        if (section !== undefined) used.add(section);

        const labels = REFERENCE_RESULT_LABELS[reference.command];

        if (section?.url === undefined) {
            return [
                {
                    label:
                        section?.error === undefined
                            ? action.labels.completed
                            : action.labels.failed,
                    target: action.target,
                    isUrl: action.isUrl,
                    error: section?.error,
                },
            ];
        }

        return [
            {
                label: section.error === undefined ? labels.completed : labels.failed,
                target: section.url,
                isUrl: true,
                error: section.error,
            },
        ];
    });
}

type WebRunResultLine = {
    readonly text: string;
    readonly kind: "title" | "url" | "paragraph" | "omission";
};

/** Shared readable presentation keeps native and optional Glowup output in parity. */
export function webRunResultLines(rawOutput: string): WebRunResultLine[] {
    const sources = parseWebRunSources(rawOutput);
    const lines: WebRunResultLine[] = [];
    for (const [index, source] of sources.entries()) {
        if (index > 0) lines.push({ kind: "paragraph", text: "" });
        if (source.title) lines.push({ kind: "title", text: source.title });
        if (source.url) lines.push({ kind: "url", text: source.url });

        for (const [paragraphIndex, paragraph] of source.paragraphs.entries()) {
            if (paragraphIndex > 0) lines.push({ kind: "paragraph", text: "" });
            lines.push({ kind: "paragraph", text: paragraph });
        }

        if (source.omitted) lines.push({ kind: "omission", text: WEB_RUN_OMISSION });
    }

    return lines.length > 0 ? lines : [{ kind: "paragraph", text: "No web output." }];
}

/** Static-label mode must still read naturally for active and restored calls. */
export function webRunLabels(
    labels: Required<GlowupCallLabels>,
    phase: WebRunPhase,
    isError: boolean,
): Required<GlowupCallLabels> {
    const label = isError
        ? labels.failed
        : phase === "running"
          ? labels.running
          : phase === "complete"
            ? labels.completed
            : labels.static;
    return { ...labels, static: label };
}
