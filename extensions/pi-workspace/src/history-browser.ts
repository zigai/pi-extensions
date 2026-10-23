import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    Input,
    Key,
    matchesKey,
    Text,
    truncateToWidth,
    type Component,
    type TUI,
} from "@earendil-works/pi-tui";
import { StoredHistory, type HistoryScope, type StoredEntry } from "./stored-history.ts";

class HistoryBrowser implements Component {
    private readonly query = new Input({ prompt: "Search: " });
    private scope: HistoryScope = "branch";
    private results: readonly StoredEntry[] = [];
    private selectedId: string | undefined;
    private detailOffset = 0;

    constructor(
        private readonly history: StoredHistory,
        private readonly tui: TUI,
        private readonly close: () => void,
        query: string,
        selectedId?: string,
    ) {
        this.selectedId = selectedId;
        if (selectedId !== undefined && history.open(selectedId)?.onCurrentBranch === false)
            this.scope = "all";

        this.query.setValue(query);
        this.query.focused = true;
        this.refresh();
    }

    invalidate(): void {
        this.query.invalidate();
    }

    handleInput(data: string): void {
        if (matchesKey(data, Key.escape)) {
            this.close();
            return;
        }

        if (matchesKey(data, "ctrl+alt+a")) {
            if (this.scope === "branch") this.scope = "all";
            else this.scope = "branch";

            this.refresh();
        } else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
            let direction = 1;
            if (matchesKey(data, Key.up)) direction = -1;

            const index = this.results.findIndex((entry) => entry.id === this.selectedId);
            const selected = this.results.at(
                Math.max(0, Math.min(this.results.length - 1, index + direction)),
            );
            this.selectedId = selected?.id;
            this.detailOffset = 0;
        } else if (matchesKey(data, Key.pageDown)) {
            this.detailOffset += Math.max(1, this.tui.terminal.rows - 8);
        } else if (matchesKey(data, Key.pageUp)) {
            this.detailOffset = Math.max(
                0,
                this.detailOffset - Math.max(1, this.tui.terminal.rows - 8),
            );
        } else if (matchesKey(data, Key.home)) {
            this.detailOffset = 0;
        } else {
            this.query.handleInput(data);
            this.refresh();
        }

        this.tui.requestRender();
    }

    render(width: number): string[] {
        const lines = [
            truncateToWidth(`Stored history · ${this.scope} · display only`, width),
            ...this.query.render(width),
            truncateToWidth("↑/↓ result · PgUp/PgDn text · Ctrl+Alt+A scope · Esc close", width),
        ];

        let selected: StoredEntry | undefined;
        if (this.selectedId !== undefined) selected = this.history.open(this.selectedId);

        if (selected === undefined) {
            lines.push(truncateToWidth(`${this.results.length} matches`, width));
            return lines;
        }

        lines.push(
            truncateToWidth(
                `${this.results.findIndex((entry) => entry.id === selected.id) + 1}/${this.results.length} · ${selected.id} · ${selected.timestamp}`,
                width,
            ),
        );

        if (!selected.onCurrentBranch)
            lines.push(truncateToWidth("Other branch · active leaf unchanged", width));

        const body = new Text(selected.text, 0, 0).render(width);
        const available = Math.max(1, this.tui.terminal.rows - lines.length - 2);
        this.detailOffset = Math.min(this.detailOffset, Math.max(0, body.length - available));
        lines.push(...body.slice(this.detailOffset, this.detailOffset + available));
        lines.push(
            truncateToWidth(
                `Lines ${this.detailOffset + 1}–${Math.min(body.length, this.detailOffset + available)} of ${body.length}`,
                width,
            ),
        );

        return lines;
    }

    private refresh(): void {
        const query = this.query.getValue();
        if (query.length === 0) this.results = this.history.list(this.scope);
        else this.results = this.history.search(query, this.scope);

        if (!this.results.some((entry) => entry.id === this.selectedId)) {
            this.selectedId = this.results.at(0)?.id;
        }
        this.detailOffset = 0;
    }
}

export async function showStoredHistory(
    ctx: ExtensionContext,
    query = "",
    selectedId?: string,
): Promise<void> {
    if (!ctx.hasUI) return;

    const history = new StoredHistory(ctx.sessionManager);

    await ctx.ui.custom<void>(
        (tui, _theme, _keybindings, done) =>
            new HistoryBrowser(history, tui, () => done(), query, selectedId),
        { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 } },
    );
}
