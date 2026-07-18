import {
    fuzzyFilter,
    Input,
    Key,
    matchesKey,
    truncateToWidth,
    visibleWidth,
    type Component,
    type Focusable,
} from "@earendil-works/pi-tui";
export type PanelCategory = "tool" | "skill" | "command" | "system-fragment" | "profile";

export interface PanelItem {
    readonly id: string;
    readonly category: PanelCategory;
    readonly label: string;
    currentValue: string;
    readonly effectiveValue: string;
    readonly decidedBy: string;
    readonly description: string;
    readonly values?: readonly string[];
}

export interface TogglesPanelStyles {
    readonly accent: (text: string) => string;
    readonly text: (text: string) => string;
    readonly muted: (text: string) => string;
    readonly dim: (text: string) => string;
    readonly warning: (text: string) => string;
    readonly success: (text: string) => string;
    readonly error: (text: string) => string;
    readonly selected: (text: string) => string;
    readonly bold: (text: string) => string;
    readonly border: (text: string) => string;
}

interface PanelTab {
    readonly category: PanelCategory;
    readonly label: string;
}

const tabs: readonly PanelTab[] = [
    { category: "tool", label: "Tools" },
    { category: "skill", label: "Skills" },
    { category: "command", label: "Commands" },
    { category: "system-fragment", label: "System" },
    { category: "profile", label: "Profile" },
];

const MAX_VISIBLE_ROWS = 12;
const POLICY_COLUMN_WIDTH = 12;

interface TableLayout {
    readonly nameWidth: number;
    readonly effectiveWidth?: number;
    readonly decidedByWidth?: number;
    readonly descriptionWidth?: number;
}

function padToWidth(value: string, width: number): string {
    return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function policyStyle(styles: TogglesPanelStyles, value: string): (text: string) => string {
    switch (value) {
        case "on":
        case "name-only":
        case "user-only":
            return styles.success;
        case "off":
            return styles.error;
        case "unsupported":
        case "unavailable":
            return styles.warning;
        default:
            return styles.muted;
    }
}

function tableLayout(width: number): TableLayout | undefined {
    if (width >= 120) {
        return {
            nameWidth: 24,
            effectiveWidth: 12,
            decidedByWidth: 14,
            descriptionWidth: width - 72,
        };
    }
    if (width >= 72) {
        return {
            nameWidth: 20,
            effectiveWidth: 12,
            descriptionWidth: width - 50,
        };
    }
    if (width >= 58) {
        return { nameWidth: width - 30, effectiveWidth: 12 };
    }
    if (width >= 34) {
        return { nameWidth: width - 16 };
    }
    return undefined;
}

function cell(value: string, width: number): string {
    return padToWidth(truncateToWidth(value, width, "…"), width);
}

function descriptionCell(value: string, width: number): string {
    if (width < 5) {
        return cell(value, width);
    }
    return `  ${cell(value, width - 4)}  `;
}

export class TogglesPanel implements Component, Focusable {
    private readonly itemsByCategory: ReadonlyMap<PanelCategory, PanelItem[]>;
    private readonly searchInputs = new Map<PanelCategory, Input>();
    private readonly selectedIndexes = new Map<PanelCategory, number>();
    private activeTabIndex: number;
    private _focused = false;

    constructor(
        items: readonly PanelItem[],
        private readonly scope: string,
        private readonly styles: TogglesPanelStyles,
        private readonly onChange: (id: string, value: string) => void,
        private readonly onCancel: () => void,
    ) {
        this.itemsByCategory = new Map(
            tabs.map(({ category }) => [
                category,
                items.filter((item) => item.category === category),
            ]),
        );
        for (const { category } of tabs) {
            this.searchInputs.set(category, new Input());
            this.selectedIndexes.set(category, 0);
        }
        const firstPopulatedTab = tabs.findIndex(
            ({ category }) => (this.itemsByCategory.get(category)?.length ?? 0) > 0,
        );
        this.activeTabIndex = firstPopulatedTab === -1 ? 0 : firstPopulatedTab;
    }

    get focused(): boolean {
        return this._focused;
    }

    set focused(value: boolean) {
        this._focused = value;
        this.updateInputFocus();
    }

    invalidate(): void {
        for (const input of this.searchInputs.values()) {
            input.invalidate();
        }
    }

    handleInput(data: string): void {
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
            this.switchTab(1);
            return;
        }
        if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
            this.switchTab(-1);
            return;
        }

        const items = this.filteredItems();
        const category = this.activeTab().category;
        const selectedIndex = this.selectedIndexes.get(category) ?? 0;
        if (matchesKey(data, Key.up)) {
            this.selectedIndexes.set(
                category,
                items.length === 0 ? 0 : selectedIndex === 0 ? items.length - 1 : selectedIndex - 1,
            );
            return;
        }
        if (matchesKey(data, Key.down)) {
            this.selectedIndexes.set(
                category,
                items.length === 0 ? 0 : selectedIndex === items.length - 1 ? 0 : selectedIndex + 1,
            );
            return;
        }
        if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
            const item = items[selectedIndex];
            if (item?.values === undefined || item.values.length === 0) {
                return;
            }
            const currentIndex = item.values.indexOf(item.currentValue);
            const nextValue = item.values[(currentIndex + 1) % item.values.length];
            if (nextValue !== undefined) {
                item.currentValue = nextValue;
                this.onChange(item.id, nextValue);
            }
            return;
        }
        if (matchesKey(data, Key.escape)) {
            this.onCancel();
            return;
        }

        const input = this.activeSearchInput();
        input.handleInput(data);
        this.selectedIndexes.set(category, 0);
    }

    render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        const lines = [this.styles.border("─".repeat(safeWidth))];
        lines.push(this.renderTitle(safeWidth), "");
        lines.push(...this.renderTabs(safeWidth), "");

        const searchPrefix = this.styles.dim("  Search");
        const inputWidth = Math.max(1, safeWidth - 11);
        lines.push(
            truncateToWidth(
                `${searchPrefix}  ${this.activeSearchInput().render(inputWidth)[0] ?? ""}`,
                safeWidth,
                "",
            ),
            "",
        );
        lines.push(...this.renderTable(safeWidth));
        lines.push("", ...this.renderFooter(safeWidth), this.styles.border("─".repeat(safeWidth)));
        return lines;
    }

    private activeTab(): PanelTab {
        return tabs[this.activeTabIndex] ?? tabs[0]!;
    }

    private renderTitle(width: number): string {
        const title = `${this.styles.accent(this.styles.bold("Pi Toggles"))}  ${this.styles.dim(`${this.scope.toUpperCase()} POLICY`)}`;
        const items = this.filteredItems();
        if (items.length <= MAX_VISIBLE_ROWS) {
            return truncateToWidth(`  ${title}`, width, "");
        }
        const selectedIndex = Math.min(
            this.selectedIndexes.get(this.activeTab().category) ?? 0,
            items.length - 1,
        );
        const indicator = this.styles.dim(`(${selectedIndex + 1}/${items.length})`);
        const availableTitleWidth = Math.max(1, width - visibleWidth(indicator) - 5);
        const visibleTitle = truncateToWidth(title, availableTitleWidth, "…");
        const gap = " ".repeat(
            Math.max(1, width - visibleWidth(visibleTitle) - visibleWidth(indicator) - 4),
        );
        return truncateToWidth(`  ${visibleTitle}${gap}${indicator}  `, width, "");
    }

    private activeSearchInput(): Input {
        return this.searchInputs.get(this.activeTab().category)!;
    }

    private filteredItems(): PanelItem[] {
        const category = this.activeTab().category;
        const items = this.itemsByCategory.get(category) ?? [];
        const query = this.searchInputs.get(category)?.getValue() ?? "";
        return query.length === 0 ? items : fuzzyFilter(items, query, (item) => item.label);
    }

    private switchTab(offset: number): void {
        this.activeTabIndex = (this.activeTabIndex + offset + tabs.length) % tabs.length;
        this.updateInputFocus();
    }

    private updateInputFocus(): void {
        for (const [category, input] of this.searchInputs) {
            input.focused = this._focused && category === this.activeTab().category;
        }
    }

    private renderTabs(width: number): string[] {
        const lines: string[] = [];
        let line = "  ";
        for (const [index, tab] of tabs.entries()) {
            const count = this.itemsByCategory.get(tab.category)?.length ?? 0;
            const label = ` ${tab.label} ${count} `;
            const styled =
                index === this.activeTabIndex
                    ? this.styles.selected(this.styles.bold(label))
                    : this.styles.muted(label);
            if (visibleWidth(line) > 2 && visibleWidth(line) + visibleWidth(styled) + 1 > width) {
                lines.push(truncateToWidth(line, width, ""));
                line = "  ";
            }
            line += `${styled} `;
        }
        lines.push(truncateToWidth(line, width, ""));
        return lines;
    }

    private renderFooter(width: number): string[] {
        const segments = ["←/→ tabs", "↑/↓ navigate", "enter change", "ctrl+s apply", "esc cancel"];
        const lines: string[] = [];
        let line = "  ";
        for (const segment of segments) {
            const separator = line === "  " ? "" : " • ";
            if (line !== "  " && visibleWidth(line) + separator.length + segment.length > width) {
                lines.push(this.styles.dim(truncateToWidth(line, width, "")));
                line = "  ";
            }
            line += `${line === "  " ? "" : " • "}${segment}`;
        }
        lines.push(this.styles.dim(truncateToWidth(line, width, "")));
        return lines;
    }

    private renderTable(width: number): string[] {
        const items = this.filteredItems();
        const category = this.activeTab().category;
        const selectedIndex = Math.min(
            this.selectedIndexes.get(category) ?? 0,
            Math.max(0, items.length - 1),
        );
        this.selectedIndexes.set(category, selectedIndex);
        if (items.length === 0) {
            const allItems = this.itemsByCategory.get(category) ?? [];
            return [
                this.styles.dim(
                    `  ${allItems.length === 0 ? "No capabilities in this category" : "No matches"}`,
                ),
            ];
        }

        const startIndex = Math.max(
            0,
            Math.min(
                selectedIndex - Math.floor(MAX_VISIBLE_ROWS / 2),
                items.length - MAX_VISIBLE_ROWS,
            ),
        );
        const endIndex = Math.min(startIndex + MAX_VISIBLE_ROWS, items.length);
        const lines: string[] = [];
        const layout = tableLayout(width);
        if (layout !== undefined) {
            const headers = [cell("NAME", layout.nameWidth), cell("POLICY", POLICY_COLUMN_WIDTH)];
            if (layout.effectiveWidth !== undefined) {
                headers.push(cell("EFFECTIVE", layout.effectiveWidth));
            }
            if (layout.decidedByWidth !== undefined) {
                headers.push(cell("DECIDED BY", layout.decidedByWidth));
            }
            if (layout.descriptionWidth !== undefined) {
                headers.push(descriptionCell("DESCRIPTION", layout.descriptionWidth));
            }
            lines.push(this.styles.dim(`  ${headers.join("  ")}`));
        }
        for (let index = startIndex; index < endIndex; index += 1) {
            const item = items[index];
            if (item === undefined) {
                continue;
            }
            const selected = index === selectedIndex;
            const cursor = selected ? "› " : "  ";
            const state = policyStyle(this.styles, item.currentValue)(item.currentValue);
            let row: string;
            if (layout === undefined) {
                row = `${cursor}${item.label}: ${state}`;
            } else {
                const cells = [
                    cell(item.label, layout.nameWidth),
                    policyStyle(
                        this.styles,
                        item.currentValue,
                    )(cell(item.currentValue, POLICY_COLUMN_WIDTH)),
                ];
                if (layout.effectiveWidth !== undefined) {
                    cells.push(
                        policyStyle(
                            this.styles,
                            item.effectiveValue,
                        )(cell(item.effectiveValue, layout.effectiveWidth)),
                    );
                }
                if (layout.decidedByWidth !== undefined) {
                    cells.push(this.styles.muted(cell(item.decidedBy, layout.decidedByWidth)));
                }
                if (layout.descriptionWidth !== undefined) {
                    cells.push(
                        this.styles.dim(descriptionCell(item.description, layout.descriptionWidth)),
                    );
                }
                row = `${cursor}${cells.join("  ")}`;
            }
            const rendered = truncateToWidth(row, width, "");
            lines.push(selected ? this.styles.selected(rendered) : this.styles.text(rendered));
        }
        return lines;
    }
}
