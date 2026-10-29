import { ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import {
    PHYSICAL_MODEL_ID,
    installLinkedMethodPatch,
    reportExtensionDiagnostic,
} from "@zigai/pi-extension-internals";

const PIN_PATCH = Symbol.for("zigai.pi-ui-tweaks.model-selector-pins");
type Model = { id: string; provider: string; [PHYSICAL_MODEL_ID]?: string };
type Item = { id: string; provider: string; model: Model };
type Text = { text: string; setText(text: string): void };
type Target = {
    filteredModels?: unknown;
    selectedIndex?: unknown;
    listContainer?: { children?: unknown };
    updateList?: (this: Target) => void;
    filterModels?: (this: Target, query: string) => void;
    [PIN_PATCH]?: Handle;
};
type Config = {
    readonly pinnedModels: readonly string[];
    readonly highlightSelectedModelProvider: boolean;
};
type Handle = { update(config: Config): void; dispose(): void };
type Theme = { fg(color: string, text: string): string };

function isItem(value: unknown): value is Item {
    return (
        typeof value === "object" &&
        value !== null &&
        "id" in value &&
        typeof value.id === "string" &&
        "provider" in value &&
        typeof value.provider === "string" &&
        "model" in value &&
        isModel(value.model)
    );
}
function isModel(value: unknown): value is Model {
    return (
        typeof value === "object" &&
        value !== null &&
        "id" in value &&
        typeof value.id === "string" &&
        "provider" in value &&
        typeof value.provider === "string" &&
        (!(PHYSICAL_MODEL_ID in value) || typeof value[PHYSICAL_MODEL_ID] === "string")
    );
}
function modelKey(item: Item): string {
    return `${item.model.provider}/${item.model[PHYSICAL_MODEL_ID] ?? item.model.id}`;
}
function isText(value: unknown): value is Text {
    return (
        typeof value === "object" &&
        value !== null &&
        "text" in value &&
        typeof value.text === "string" &&
        "setText" in value &&
        typeof value.setText === "function"
    );
}
function isString(value: unknown): value is string {
    return typeof value === "string";
}
function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(isString);
}
function decorateRow(
    child: Text,
    theme: Theme,
    pinned: boolean,
    showPinColumn: boolean,
    selectedProvider: string | undefined,
): void {
    if ("render" in child && typeof child.render === "function") {
        const original = child.render;
        child.render = function (width: number): string[] {
            let contentWidth = width;
            if (showPinColumn && width >= 6) contentWidth -= 2;
            const lines: unknown = original.call(this, Math.max(1, contentWidth));
            if (!isStringArray(lines)) return [];
            let line = lines[0];
            if (line === undefined) return lines;
            if (selectedProvider !== undefined && !line.includes(`[${selectedProvider}]`)) {
                const index = line.lastIndexOf(selectedProvider);
                if (index !== -1)
                    line = `${line.slice(0, index)}${theme.fg("accent", selectedProvider)}${line.slice(index + selectedProvider.length)}`;
            }
            if (showPinColumn && width >= 6 && visibleWidth(line) >= 4) {
                let marker = " ";
                if (pinned) marker = theme.fg("warning", "*");
                line = `${sliceByColumn(line, 0, 4)}${marker} ${sliceByColumn(line, 4, width - 6)}`;
            }
            return [line, ...lines.slice(1)];
        };
        if (showPinColumn) {
            // A provider-row wrapper installed later must fit around this inner column.
            Object.defineProperty(child.render, Symbol.for("zigai.model-selector-pin-column"), {
                value: true,
            });
        }
    } else if (pinned) child.setText(`${child.text} ${theme.fg("warning", "*")}`);
}
function hasMethods(
    value: unknown,
): value is Target & Required<Pick<Target, "updateList" | "filterModels">> {
    return (
        typeof value === "object" &&
        value !== null &&
        "updateList" in value &&
        typeof value.updateList === "function" &&
        "filterModels" in value &&
        typeof value.filterModels === "function"
    );
}

function hasSelectedIndex(target: Target): target is Target & { selectedIndex: number } {
    return typeof target.selectedIndex === "number";
}

export function installModelSelectorPinsPatch(
    config: Config,
    getTheme: () => Theme | undefined,
    providedTarget?: Target | null,
): Handle {
    let target: Target | null = providedTarget ?? null;
    if (providedTarget === undefined && hasMethods(ModelSelectorComponent.prototype))
        target = ModelSelectorComponent.prototype;
    if (!hasMethods(target)) {
        reportExtensionDiagnostic(
            "[pi-ui-tweaks] model pins patch unavailable; Pi internals may have changed",
        );
        return { update() {}, dispose() {} };
    }
    if (target[PIN_PATCH]) {
        target[PIN_PATCH].update(config);
        return target[PIN_PATCH];
    }
    let current = config;
    let filtering = false;
    const listPatch = installLinkedMethodPatch(
        target,
        "updateList",
        (predecessor) =>
            function (this: Target): void {
                const models = this.filteredModels;
                let selected = 0;
                if (hasSelectedIndex(this)) selected = this.selectedIndex;
                if (
                    Array.isArray(models) &&
                    models.every(isItem) &&
                    current.pinnedModels.length > 0
                ) {
                    const previous = models[selected];
                    const rank = new Map<string, number>();
                    current.pinnedModels.forEach((key, index) => {
                        if (!rank.has(key)) rank.set(key, index);
                    });
                    // Copy: Pi sometimes aliases filteredModels to activeModels.
                    const sorted = [...models].sort(
                        (a, b) =>
                            (rank.get(modelKey(a)) ?? Infinity) -
                            (rank.get(modelKey(b)) ?? Infinity),
                    );
                    this.filteredModels = sorted;
                    if (filtering) this.selectedIndex = 0;
                    else if (previous !== undefined) this.selectedIndex = sorted.indexOf(previous);
                }
                predecessor.call(this);
                const sorted = this.filteredModels;
                const children = this.listContainer?.children;
                const theme = getTheme();
                if (
                    !Array.isArray(sorted) ||
                    !sorted.every(isItem) ||
                    !Array.isArray(children) ||
                    theme === undefined ||
                    !hasSelectedIndex(this)
                )
                    return;
                const start = Math.max(0, Math.min(this.selectedIndex - 5, sorted.length - 10));
                const showPinColumn = sorted.some((item) =>
                    current.pinnedModels.includes(modelKey(item)),
                );
                for (let i = 0; i < Math.min(10, sorted.length - start); i++) {
                    const item = sorted[start + i];
                    const child: unknown = children[i];
                    if (item === undefined || !isText(child)) continue;
                    const pinned = current.pinnedModels.includes(modelKey(item));
                    let selectedProvider: string | undefined;
                    if (current.highlightSelectedModelProvider && start + i === this.selectedIndex)
                        selectedProvider = item.provider;
                    if (showPinColumn || selectedProvider !== undefined)
                        decorateRow(child, theme, pinned, showPinColumn, selectedProvider);
                }
            },
    );
    const filterPatch = installLinkedMethodPatch(
        target,
        "filterModels",
        (predecessor) =>
            function (this: Target, query: string): void {
                filtering = query.length > 0;
                try {
                    predecessor.call(this, query);
                } finally {
                    filtering = false;
                }
            },
    );
    let disposed = false;
    const handle: Handle = {
        update(next) {
            if (!disposed) current = next;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            filterPatch.dispose();
            listPatch.dispose();
            if (target[PIN_PATCH] === handle) delete target[PIN_PATCH];
        },
    };
    target[PIN_PATCH] = handle;
    return handle;
}
