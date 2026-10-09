import { getAgentDir } from "@earendil-works/pi-coding-agent";
import fs from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import type {
    Selection,
    SelectionHistory,
    SelectionHistoryOptions,
} from "./initial-suggestions.ts";

const HISTORY_VERSION = 1;
const MAX_HISTORY_ENTRIES = 1_000;

const selectionSchema = Type.Object(
    {
        count: Type.Integer({ minimum: 1 }),
        lastSelectedAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);

const selectionHistorySchema = Type.Object(
    {
        version: Type.Literal(HISTORY_VERSION),
        selections: Type.Record(Type.String({ minLength: 1 }), selectionSchema),
    },
    { additionalProperties: false },
);

type SelectionHistoryFile = Static<typeof selectionHistorySchema>;

function isNodeErrorWithCode(cause: unknown): cause is Error & { readonly code: string } {
    return cause instanceof Error && "code" in cause && typeof cause.code === "string";
}

function parseHistory(text: string): Map<string, Selection> {
    const parsed: unknown = JSON.parse(text);
    if (!Value.Check(selectionHistorySchema, parsed)) {
        throw new Error("selection history has an invalid structure");
    }

    const history = Value.Parse(selectionHistorySchema, parsed);
    return new Map(Object.entries(history.selections));
}

function historyFile(selections: ReadonlyMap<string, Selection>): SelectionHistoryFile {
    const recentSelections = [...selections.entries()]
        .sort((left, right) => right[1].lastSelectedAt - left[1].lastSelectedAt)
        .slice(0, MAX_HISTORY_ENTRIES);

    return {
        version: HISTORY_VERSION,
        selections: Object.fromEntries(recentSelections),
    };
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

    try {
        await fs.writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
        await fs.rename(temporaryPath, filePath);
    } catch (cause) {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);

        throw cause;
    }
}

export function createSelectionHistory(options: SelectionHistoryOptions): SelectionHistory {
    const filePath = options.filePath ?? path.join(getAgentDir(), "state", options.stateFileName);
    const now = options.now ?? Date.now;
    let selections = new Map<string, Selection>();
    let loadTask: Promise<void> | undefined;
    let pendingWrites = Promise.resolve();
    let errorReported = false;

    const reportError = (): void => {
        if (errorReported) return;

        errorReported = true;
        options.onError?.(options.errorMessage);
    };

    const ensureLoaded = async (): Promise<void> => {
        if (loadTask !== undefined) return loadTask;

        loadTask = fs
            .readFile(filePath, "utf8")
            .then((text) => {
                selections = parseHistory(text);
            })
            .catch((cause: unknown) => {
                if (!isNodeErrorWithCode(cause) || cause.code !== "ENOENT") reportError();
                selections = new Map();
            });

        return loadTask;
    };

    const persist = async (): Promise<void> => {
        const content = `${JSON.stringify(historyFile(selections), null, 2)}\n`;
        await atomicWrite(filePath, content);
    };

    return {
        async load() {
            await ensureLoaded();
            return new Map(selections);
        },
        recordSelection(name) {
            pendingWrites = pendingWrites
                .then(async () => {
                    await ensureLoaded();

                    const previous = selections.get(name);
                    selections.set(name, {
                        count: (previous?.count ?? 0) + 1,
                        lastSelectedAt: now(),
                    });
                    await persist();
                })
                .catch(() => {
                    reportError();
                });
        },
        async flush() {
            await pendingWrites;
        },
    };
}
