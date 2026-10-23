import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { readLogPage, type LogPage, type LogPageTarget } from "./log-pages.ts";
import { commandLabel } from "./presentation.ts";

type ViewerHost = {
    readonly rows: () => number;
    readonly requestRender: () => void;
    readonly close: () => void;
    readonly signal?: AbortSignal;
};

type PageRequest = { readonly target: LogPageTarget; readonly bottom: boolean };

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function wrapLogText(text: string, width: number): string[] {
    // Log pages retain boundary whitespace that the SDK's word wrapping trims.
    const lines: string[] = [];
    let line = "";
    let columns = 0;
    for (const { segment } of graphemes.segment(text.replace(/\t/gu, "    "))) {
        if (segment === "\n") {
            lines.push(line);
            line = "";
            columns = 0;
            continue;
        }

        const size = visibleWidth(segment);
        if (columns + size > width && line.length > 0) {
            lines.push(line);
            line = "";
            columns = 0;
        }

        line += segment;
        columns += size;
    }

    lines.push(line);

    return lines;
}

/** One active bounded read, one replaceable navigation request, and only the current page. */
export class LogViewer implements Component {
    private readonly controller = new AbortController();
    private readonly title: string;
    private page: LogPage | undefined;
    private error: string | undefined;
    private pending: PageRequest | undefined;
    private work: Promise<void> | undefined;
    private closed = false;
    private offset = 0;
    private bottom = false;
    private width = 0;
    private lines: string[] = [];
    private retryTarget: LogPageTarget = 0;

    constructor(
        private readonly path: string,
        title: string,
        private readonly host: ViewerHost,
    ) {
        this.title = commandLabel(title);
        host.signal?.addEventListener("abort", this.close, { once: true });

        if (host.signal?.aborted === true) this.close();
        else this.request(0);
    }

    readonly close = (): void => {
        if (this.closed) return;

        this.dispose();
        this.host.close();
    };

    dispose(): void {
        if (this.closed) return;

        this.closed = true;
        this.controller.abort();
        this.host.signal?.removeEventListener("abort", this.close);
        this.pending = undefined;
        this.page = undefined;
        this.lines = [];
    }

    /** Also lets lifecycle owners wait for the final bounded read and descriptor close. */
    async whenIdle(): Promise<void> {
        await this.work;
    }

    invalidate(): void {
        this.width = 0;
        this.lines = [];
    }

    handleInput(data: string): void {
        if (this.closed) return;

        if (data === "q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.close();
        else if (matchesKey(data, "home")) this.request(0);
        else if (matchesKey(data, "end")) this.request("end", true);
        else if (data === "r") this.request(this.retryTarget, this.bottom);
        else if (matchesKey(data, "pageDown") || matchesKey(data, "right")) {
            if (this.page !== undefined) this.request(this.page.index + 1);
        } else if (matchesKey(data, "pageUp") || matchesKey(data, "left")) {
            if (this.page !== undefined) this.request(Math.max(0, this.page.index - 1));
        } else if (matchesKey(data, "up") || matchesKey(data, "down")) {
            this.bottom = false;
            if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
            else this.offset = Math.min(this.maxOffset(), this.offset + 1);

            this.host.requestRender();
        }
    }

    private request(target: LogPageTarget, bottom = false): void {
        if (this.closed) return;

        this.pending = { target, bottom };
        this.page = undefined;
        this.error = undefined;
        this.offset = 0;
        this.invalidate();
        this.work ??= this.drain();

        this.host.requestRender();
    }

    private async drain(): Promise<void> {
        try {
            while (!this.closed && this.pending !== undefined) {
                const request = this.pending;
                this.pending = undefined;
                this.retryTarget = request.target;

                try {
                    const page = await readLogPage(this.path, request.target, {
                        signal: this.controller.signal,
                    });

                    if (this.shouldDiscard()) continue;

                    this.page = page;
                    this.invalidate();
                    this.retryTarget = page.index;
                    this.bottom = request.bottom;
                } catch {
                    if (this.shouldDiscard()) continue;

                    this.error = "Could not read log. Press r to retry.";
                }

                this.host.requestRender();
            }
        } finally {
            this.work = undefined;
        }
    }

    private shouldDiscard(): boolean {
        return this.closed || this.pending !== undefined;
    }

    private bodyRows(): number {
        return Math.max(1, this.host.rows() - 3);
    }

    private maxOffset(): number {
        return Math.max(0, this.lines.length - this.bodyRows());
    }

    render(width: number): string[] {
        if (this.closed || width < 1) return [];

        if (width !== this.width) {
            this.lines = [];
            if (this.page !== undefined) this.lines = wrapLogText(this.page.text, width);
            this.width = width;
        }

        if (this.bottom) this.offset = this.maxOffset();
        this.offset = Math.min(this.offset, this.maxOffset());

        let status = "Loading log…";
        if (this.page !== undefined) {
            status = `Page ${this.page.index + 1}/${this.page.count} · bytes ${this.page.start}–${this.page.end} of ${this.page.size} · row ${this.offset + 1}/${this.lines.length}`;
        }

        let body = this.lines.slice(this.offset, this.offset + this.bodyRows());
        if (this.page?.size === 0) body = ["(no output)"];
        if (this.error !== undefined) body = [this.error];

        return [
            this.title,
            status,
            ...body,
            "PgUp/PgDn or ←/→ page · ↑/↓ scroll · Home/End · r refresh · q/Esc close",
        ]
            .slice(0, Math.max(1, this.host.rows()))
            .map((line) => truncateToWidth(line, width, ""));
    }
}
