import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
    extract,
    parseTranscript,
    ProjectIdentity,
    type Occurrence,
    type Scope,
} from "./search.ts";

export interface SearchSnapshot {
    rows: Occurrence[];
    loading: boolean;
    failures: number;
    storageUnavailable: boolean;
}

export interface SearchSourceOptions {
    root: string;
    session: string;
    cwd: string;
    sessionCwd?: string;
    live: () => readonly unknown[];
}

/** A fresh scan per scope/open avoids stale mtime/size caches, including same-size rewrites. */
export class HistorySource {
    private generation = 0;
    private abort: AbortController | undefined;
    private refresh: (() => void) | undefined;
    private readonly projects = new ProjectIdentity();

    constructor(private readonly options: SearchSourceOptions) {}

    cancel(): void {
        this.generation++;
        this.abort?.abort();
        this.refresh = undefined;
    }

    refreshLive(): void {
        this.refresh?.();
    }

    async scan(scope: Scope, update: (snapshot: SearchSnapshot) => void): Promise<void> {
        this.cancel();

        const abort = new AbortController();
        this.abort = abort;

        const generation = this.generation;
        const active = () => generation === this.generation;
        const { session, cwd, live, root } = this.options;
        const sessionCwd = this.options.sessionCwd ?? cwd;
        let includeLive = scope !== "project";
        const liveRows = () => {
            if (!includeLive) return [];
            return extract(live(), session, sessionCwd);
        };
        const state: SearchSnapshot = {
            rows: liveRows(),
            loading: scope !== "session",
            failures: 0,
            storageUnavailable: false,
        };
        const publish = () => {
            if (active()) update({ ...state, rows: [...state.rows] });
        };

        this.refresh = () => {
            state.rows = state.rows.filter((row) => row.session !== session).concat(liveRows());
            publish();
        };
        publish();

        if (scope === "session") return;

        const project = await this.projects.resolve(cwd);
        if (scope === "project") {
            includeLive = (await this.projects.resolve(sessionCwd)) === project;

            if (!active()) return;

            this.refreshLive();
        }

        if (!active()) return;

        const visit = async (directory: string, isRoot: boolean): Promise<void> => {
            if (!active()) return;

            let files: Dirent[];
            try {
                files = await readdir(directory, { withFileTypes: true });
            } catch {
                state.failures++;
                if (isRoot) state.storageUnavailable = true;
                publish();

                return;
            }

            // Four workers bound parsing and Git subprocess concurrency; symlinks are not traversed.
            let next = 0;
            const worker = async () => {
                while (active()) {
                    const file = files.at(next++);
                    if (file === undefined) return;

                    const path = join(directory, file.name);

                    if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
                    try {
                        const rows = parseTranscript(
                            await readFile(path, { encoding: "utf8", signal: abort.signal }),
                        );

                        if (!active()) return;

                        for (const row of rows) {
                            if (!active()) return;
                            if (row.session === session) continue; // live getEntries includes all saved branches
                            if (
                                scope === "global" ||
                                (await this.projects.resolve(row.cwd)) === project
                            )
                                state.rows.push(row);
                        }
                    } catch {
                        state.failures++;
                    }

                    publish();
                }
            };

            // Directories are visited serially to keep the bound global rather than per directory.
            if (isRoot) {
                for (const file of files) {
                    if (!active()) return;
                    if (file.isDirectory()) await visit(join(directory, file.name), false);
                }

                files = files.filter((file) => !file.isDirectory());
            }

            await Promise.all(Array.from({ length: 4 }, worker));
        };

        try {
            await visit(root, true);
        } catch {
            state.storageUnavailable = true;
            state.failures++;
        }

        if (!active()) return;

        // Refresh unsaved messages that arrived during discovery, without duplicating saved occurrences.
        state.rows = state.rows.filter((row) => row.session !== session).concat(liveRows());
        state.loading = false;
        publish();
    }
}
