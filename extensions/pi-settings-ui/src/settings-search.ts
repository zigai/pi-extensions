import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
    fuzzyFilter,
    Input,
    Key,
    matchesKey,
    truncateToWidth,
    wrapTextWithAnsi,
    type Component,
    type Focusable,
} from "@earendil-works/pi-tui";

export type SettingsSearchEntry = {
    readonly tabIndex: number;
    readonly breadcrumb: string;
    readonly description: string;
    readonly keywords: string;

    readonly target:
        | { readonly kind: "pi"; readonly id: string }
        | { readonly kind: "extension"; readonly fieldIndex: number };
};

export type SettingsSearchScope = {
    readonly tabIndex: number | undefined;
    readonly title: string;
};

type SettingsSearchOptions = {
    readonly entries: readonly SettingsSearchEntry[];
    readonly scopes: readonly SettingsSearchScope[];
    readonly initialScope: number | undefined;
    readonly theme: Pick<Theme, "fg" | "bg" | "bold">;
    readonly keybindings: Pick<KeybindingsManager, "matches">;
    readonly rows: () => number;
    readonly requestRender: () => void;
    readonly select: (entry: SettingsSearchEntry) => void;
    readonly close: () => void;
    readonly scopeChanged: (scope: number | undefined) => void;
};

export class SettingsSearch implements Component, Focusable {
    private readonly input = new Input();
    private scopeInput: Input | undefined;
    private scope: number | undefined;
    private selectedIndex = 0;
    private scrollOffset = 0;
    private scopeIndex = 0;
    private scopeOffset = 0;
    private _focused = false;

    constructor(private readonly options: SettingsSearchOptions) {
        this.scope = options.initialScope;
    }

    get focused(): boolean {
        return this._focused;
    }

    set focused(value: boolean) {
        this._focused = value;
        this.input.focused = value && this.scopeInput === undefined;
        if (this.scopeInput !== undefined) this.scopeInput.focused = value;
    }

    invalidate(): void {
        this.input.invalidate();
        this.scopeInput?.invalidate();
    }

    openScopePicker(): void {
        this.scopeInput = new Input();
        this.scopeIndex = Math.max(
            0,
            this.options.scopes.findIndex((scope) => scope.tabIndex === this.scope),
        );
        this.scopeOffset = 0;
        this.focused = this._focused;
        this.options.requestRender();
    }

    handleInput(data: string): void {
        if (this.scopeInput !== undefined) {
            this.handleScopeInput(data);
            return;
        }

        if (this.options.keybindings.matches(data, "tui.select.cancel")) {
            this.options.close();
            return;
        }

        if (matchesKey(data, Key.ctrl("s"))) {
            this.openScopePicker();
            return;
        }

        const entries = this.matches();
        if (this.options.keybindings.matches(data, "tui.select.confirm")) {
            const entry = entries[this.selectedIndex];
            if (entry !== undefined) this.options.select(entry);
            return;
        }

        if (this.moveSelection(data, entries.length, false)) return;

        const previous = this.input.getValue();
        this.input.handleInput(data);

        if (previous !== this.input.getValue()) {
            this.selectedIndex = 0;
            this.scrollOffset = 0;

            if (previous !== "" && this.input.getValue() === "") {
                this.options.close();
                return;
            }
        }

        this.options.requestRender();
    }

    render(width: number): string[] {
        const theme = this.options.theme;
        const input = this.scopeInput ?? this.input;
        const lines = [theme.fg("accent", theme.bold("Search settings")), ...input.render(width)];
        const scopeTitle =
            this.options.scopes.find((scope) => scope.tabIndex === this.scope)?.title ??
            "Everything";

        lines.push(theme.fg("muted", `Search scope: ${scopeTitle} · Ctrl+S change`), "");

        const count = this.visibleCount();
        if (this.scopeInput !== undefined) {
            lines.push(theme.fg("accent", "Choose search scope"));

            const scopes = this.matchingScopes();
            this.scopeOffset = this.visibleOffset(this.scopeOffset, this.scopeIndex, scopes.length);
            for (const [index, scope] of scopes
                .slice(this.scopeOffset, this.scopeOffset + count)
                .entries()) {
                lines.push(
                    this.renderChoice(
                        scope.title,
                        index + this.scopeOffset === this.scopeIndex,
                        width,
                    ),
                );
            }

            if (scopes.length === 0) lines.push(theme.fg("dim", "No matching scopes."));
        } else {
            const entries = this.matches();
            lines.push(theme.fg("dim", `${entries.length} matching settings`));
            this.scrollOffset = this.visibleOffset(
                this.scrollOffset,
                this.selectedIndex,
                entries.length,
            );
            for (const [index, entry] of entries
                .slice(this.scrollOffset, this.scrollOffset + count)
                .entries()) {
                lines.push(
                    this.renderChoice(
                        entry.breadcrumb,
                        index + this.scrollOffset === this.selectedIndex,
                        width,
                    ),
                );
            }

            if (entries.length === 0) lines.push(theme.fg("dim", "No matching settings."));

            const selected = entries[this.selectedIndex];
            if (selected !== undefined) {
                lines.push(
                    "",
                    ...wrapTextWithAnsi(theme.fg("muted", selected.description), width).slice(0, 3),
                );
            }
        }

        lines.push("", theme.fg("dim", "Type to search · ↑↓ move · Enter select · Esc back"));

        return lines.map((line) => truncateToWidth(line, width, ""));
    }

    private matches(): SettingsSearchEntry[] {
        const entries = this.options.entries.filter(
            (entry) => this.scope === undefined || entry.tabIndex === this.scope,
        );

        return fuzzyFilter(
            entries,
            this.input.getValue(),
            (entry) => `${entry.keywords} ${entry.breadcrumb} ${entry.description}`,
        );
    }

    private matchingScopes(): SettingsSearchScope[] {
        return fuzzyFilter(
            [...this.options.scopes],
            this.scopeInput?.getValue() ?? "",
            (scope) => scope.title,
        );
    }

    private visibleCount(): number {
        return Math.max(1, this.options.rows() - 16);
    }

    private visibleOffset(offset: number, selected: number, count: number): number {
        return Math.max(
            0,
            Math.min(
                selected,
                Math.max(offset, selected - this.visibleCount() + 1),
                Math.max(0, count - this.visibleCount()),
            ),
        );
    }

    private renderChoice(label: string, selected: boolean, width: number): string {
        const text = truncateToWidth(`  ${label}`, width, "…");
        if (!selected) return this.options.theme.fg("muted", text);
        return this.options.theme.bg(
            "selectedBg",
            this.options.theme.fg("accent", this.options.theme.bold(`▎${text.slice(1)}`)),
        );
    }

    private moveSelection(data: string, count: number, scope: boolean): boolean {
        let offset = 0;
        if (this.options.keybindings.matches(data, "tui.select.up")) offset = -1;
        else if (this.options.keybindings.matches(data, "tui.select.down")) offset = 1;
        else if (this.options.keybindings.matches(data, "tui.select.pageUp"))
            offset = -this.visibleCount();
        else if (this.options.keybindings.matches(data, "tui.select.pageDown"))
            offset = this.visibleCount();
        else return false;

        if (scope) this.scopeIndex = Math.max(0, Math.min(count - 1, this.scopeIndex + offset));
        else this.selectedIndex = Math.max(0, Math.min(count - 1, this.selectedIndex + offset));

        this.options.requestRender();

        return true;
    }

    private handleScopeInput(data: string): void {
        const input = this.scopeInput;
        if (input === undefined) return;

        if (this.options.keybindings.matches(data, "tui.select.cancel")) {
            this.scopeInput = undefined;
            this.focused = this._focused;
        } else if (this.options.keybindings.matches(data, "tui.select.confirm")) {
            const scope = this.matchingScopes()[this.scopeIndex];
            if (scope !== undefined) {
                this.scope = scope.tabIndex;
                this.options.scopeChanged(this.scope);
                this.scopeInput = undefined;
                this.selectedIndex = 0;
                this.scrollOffset = 0;
                this.focused = this._focused;
            }
        } else if (this.moveSelection(data, this.matchingScopes().length, true)) {
            return;
        } else {
            const previous = input.getValue();
            input.handleInput(data);

            if (previous !== input.getValue()) {
                this.scopeIndex = 0;
                this.scopeOffset = 0;
            }
        }

        this.options.requestRender();
    }
}
