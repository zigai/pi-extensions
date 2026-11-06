import { type Occurrence, tokens } from "./search.ts";

interface IndexedPrompt {
    row: Occurrence;
    searchText: string;
    position: number;
}

function newestFirst(a: Occurrence, b: Occurrence): number {
    return (
        b.timestamp.localeCompare(a.timestamp) ||
        b.session.localeCompare(a.session) ||
        b.entry.localeCompare(a.entry)
    );
}

function compareIndexed(a: IndexedPrompt, b: IndexedPrompt): number {
    return newestFirst(a.row, b.row) || a.position - b.position;
}

/** Ingest immutable cumulative snapshots; replacements/truncation rebuild rather than retain stale rows. */
export class HistoryIndex {
    private rows: readonly Occurrence[] = [];
    private readonly byText = new Map<string, IndexedPrompt>();
    private ordered: IndexedPrompt[] = [];
    private previousTerms: string[] = [];
    private previousMatches: IndexedPrompt[] | undefined;

    update(rows: readonly Occurrence[]): void {
        let appendOnly = rows.length >= this.rows.length;
        for (let i = 0; appendOnly && i < this.rows.length; i++) {
            if (rows[i] !== this.rows[i]) appendOnly = false;
        }

        let start = this.rows.length;
        if (!appendOnly) {
            start = 0;
            this.byText.clear();
            this.ordered = [];
        }

        if (appendOnly && start === rows.length) return;

        const additions = new Map<string, IndexedPrompt>();
        for (let position = start; position < rows.length; position++) {
            const row = rows.at(position);
            if (row === undefined) continue;

            const previous = this.byText.get(row.text);
            if (previous !== undefined && newestFirst(previous.row, row) <= 0) continue;

            const indexed = {
                row,
                position,
                // Join produces one normalized string instead of retaining a rope for
                // every whitespace replacement until a nonempty query flattens it.
                searchText: previous?.searchText ?? row.text.toLowerCase().split(/\s+/u).join(" "),
            };

            this.byText.set(row.text, indexed);
            additions.set(row.text, indexed);
        }

        const added = [...additions.values()].sort(compareIndexed);
        const merged: IndexedPrompt[] = [];
        let next = 0;
        for (const existing of this.ordered) {
            if (additions.has(existing.row.text)) continue;

            while (next < added.length) {
                const candidate = added.at(next);
                if (candidate === undefined || compareIndexed(candidate, existing) > 0) break;

                merged.push(candidate);
                next++;
            }

            merged.push(existing);
        }

        for (; next < added.length; next++) {
            const candidate = added.at(next);
            if (candidate !== undefined) merged.push(candidate);
        }

        this.ordered = merged;
        this.rows = rows.slice();
        this.previousMatches = undefined;
    }

    query(query: string): Occurrence[] {
        const terms = tokens(query);
        let candidates = this.ordered;
        if (
            this.previousMatches !== undefined &&
            this.previousTerms.every((previous) => terms.some((term) => term.includes(previous)))
        )
            candidates = this.previousMatches;

        const matches = candidates.filter((row) =>
            terms.every((term) => row.searchText.includes(term)),
        );

        this.previousTerms = terms;
        this.previousMatches = matches;

        return matches.map((row) => row.row);
    }
}
