import {
    Input,
    matchesKey,
    truncateToWidth,
    wrapTextWithAnsi,
    type Component,
    type Focusable,
} from "@earendil-works/pi-tui";
import { identity, scopes, scopeLabels, type Occurrence, type Scope } from "./search.ts";
import { HistoryIndex } from "./history-index.ts";
import { HistorySource, type SearchSnapshot } from "./source.ts";

/** Strip control/format characters before terminal rendering; insertion always uses the untouched text. */
export function safeText(text: string): string {
    return text.replace(/[\p{Cc}\p{Cf}]/gu, (character) => {
        if (character === "\n" || character === "\t") return character;
        return "�";
    });
}

export class HistoryPicker implements Component, Focusable {
    private readonly input = new Input({ prompt: "Search: " });

    private snapshot: SearchSnapshot = {
        rows: [],
        loading: true,
        failures: 0,
        storageUnavailable: false,
    };

    private readonly index = new HistoryIndex();
    private results: Occurrence[] = [];
    private selected = 0;
    private previewOffset = 0;
    private closed = false;
    private pageSize = 5;

    constructor(
        private scope: Scope,
        private readonly source: HistorySource,
        private readonly repaint: () => void,
        private readonly finish: (text: string | undefined) => void,
        private readonly height: () => number,
    ) {
        this.start();
    }

    get focused(): boolean {
        return this.input.focused;
    }

    set focused(value: boolean) {
        this.input.focused = value;
    }

    private start(): void {
        void this.source.scan(this.scope, (snapshot) => {
            if (this.closed) return;

            const previous = this.results.at(this.selected);

            this.snapshot = snapshot;
            this.index.update(snapshot.rows);
            this.results = this.index.query(this.input.getValue());
            if (previous !== undefined) {
                const position = this.results.findIndex(
                    (row) => identity(row) === identity(previous),
                );
                if (position >= 0) this.selected = position;
            }

            this.selected = Math.max(0, Math.min(this.selected, this.results.length - 1));
            this.repaint();
        });
    }

    private close(text?: string): void {
        if (this.closed) return;

        this.closed = true;
        this.source.cancel();
        this.finish(text);
    }

    dispose(): void {
        this.closed = true;
        this.source.cancel();
    }

    refreshLive(): void {
        this.source.refreshLive();
    }

    cancel(): void {
        this.close();
    }

    invalidate(): void {
        this.input.invalidate();
    }

    handleInput(data: string): void {
        if (this.closed) return;

        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
            this.close();
            return;
        }

        if (matchesKey(data, "enter") || matchesKey(data, "tab")) {
            const row = this.results.at(this.selected);
            if (row !== undefined) this.close(row.text);
            return;
        }

        if (matchesKey(data, "ctrl+r")) return;

        if (matchesKey(data, "ctrl+s")) {
            const next = scopes.at((scopes.indexOf(this.scope) + 1) % scopes.length);
            if (next !== undefined) this.scope = next;
            this.selected = 0;
            this.previewOffset = 0;
            this.results = [];
            this.start();

            return;
        }

        if (matchesKey(data, "ctrl+up")) this.previewOffset = Math.max(0, this.previewOffset - 1);
        else if (matchesKey(data, "ctrl+down")) this.previewOffset++;
        else if (
            matchesKey(data, "up") ||
            matchesKey(data, "down") ||
            matchesKey(data, "pageUp") ||
            matchesKey(data, "pageDown")
        ) {
            let delta = 1;
            if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) delta = this.pageSize;
            if (matchesKey(data, "up") || matchesKey(data, "pageUp")) delta = -delta;
            this.selected = Math.max(0, Math.min(this.results.length - 1, this.selected + delta));
            this.previewOffset = 0;
        } else {
            const before = this.input.getValue();
            this.input.handleInput(data);

            const sanitized = safeText(this.input.getValue()).replace(/\s/gu, " ");
            if (sanitized !== this.input.getValue()) this.input.setValue(sanitized);

            if (before !== this.input.getValue()) {
                this.results = this.index.query(this.input.getValue());
                this.selected = 0;
                this.previewOffset = 0;
            }
        }

        this.repaint();
    }

    render(width: number): string[] {
        const height = Math.max(1, Math.min(this.height() - 2, Math.floor(this.height() * 0.95)));
        let status = `${this.results.length} matches`;
        if (this.snapshot.loading) status += " · Loading…";

        if (this.snapshot.storageUnavailable)
            status += " · Storage unavailable: live-only coverage";
        else if (this.snapshot.failures)
            status += ` · Partial: ${this.snapshot.failures} unreadable sessions/directories`;

        const lines = [
            `Prompt history · ${scopeLabels[this.scope]} · ${status}`,
            ...this.input.render(width),
        ];

        this.pageSize = Math.max(1, Math.min(8, Math.floor((height - 6) / 2)));

        const start = Math.floor(this.selected / this.pageSize) * this.pageSize;
        for (const [offset, row] of this.results.slice(start, start + this.pageSize).entries()) {
            let prefix = "  ";
            if (start + offset === this.selected) prefix = "> ";

            lines.push(
                `${prefix}${row.timestamp.slice(0, 16)} ${safeText(row.text).replace(/\s+/gu, " ")}`,
            );
        }

        if (!this.results.length) {
            let empty = "No matches in this scope";
            if (!this.input.getValue().trim()) empty = "No prompts in this scope";
            lines.push(empty);
        }

        const selected = this.results.at(this.selected);
        const room = Math.max(0, height - lines.length - 2);
        if (selected !== undefined && room > 0) {
            const preview = safeText(selected.text)
                .split("\n")
                .flatMap((line) =>
                    wrapTextWithAnsi(line.replace(/\t/gu, "    "), Math.max(1, width)),
                );

            this.previewOffset = Math.min(
                this.previewOffset,
                Math.max(0, preview.length - Math.max(1, room - 1)),
            );
            lines.push(
                `Preview · lines ${this.previewOffset + 1}–${Math.min(preview.length, this.previewOffset + Math.max(1, room - 1))}/${preview.length} · Ctrl+↑/↓ scroll`,
            );
            lines.push(
                ...preview.slice(this.previewOffset, this.previewOffset + Math.max(0, room - 1)),
            );
        }

        const footer = "Ctrl+S scope · ↑/↓ PgUp/PgDn · Enter/Tab copy · Esc/Ctrl+C cancel";

        return [...lines.slice(0, Math.max(0, height - 1)), footer].map((line) =>
            truncateToWidth(line, Math.max(0, width)),
        );
    }
}
