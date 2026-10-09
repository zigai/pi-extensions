import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PROVIDER_GAP_EXTRA_WIDTH = 2;
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
const SEARCH_COUNTER_RENDER_PATCH_KEY = Symbol.for(
    "zigai.pi-model-alias.model-selector-search-counter-render-patched",
);

const searchCounterByInput = new WeakMap<object, string>();
const providerRowLayoutByComponent = new WeakMap<object, ProviderRowLayout>();
const responsiveProviderRowComponents = new WeakSet();

export type ProviderRow = {
    readonly modelText: string;
    readonly providerText: string;
};

export type ProviderRowComponent = {
    text?: unknown;
    setText?: unknown;
    render?: unknown;
};

export type ListContainer = {
    children: ProviderRowComponent[];
};

export type SearchInput = {
    [SEARCH_COUNTER_RENDER_PATCH_KEY]?: true;
    render(width: number): string[];
};

type ProviderRowLayout = {
    readonly fullText: string;
    readonly modelPrefix: string;
    readonly checkmark: string;
    readonly providerText: string;
};

type TextComponentView = ProviderRowComponent & {
    text?: string;
    setText?: (text: string) => void;
};

type RenderableTextComponent = TextComponentView & {
    render(width: number): string[];
};

function isTextComponentView(value: ProviderRowComponent): value is TextComponentView {
    return (
        (!("text" in value) || typeof value.text === "string") &&
        (!("setText" in value) || typeof value.setText === "function")
    );
}

function textComponentValue(component: ProviderRowComponent): string | undefined {
    if (!isTextComponentView(component)) return undefined;
    return component.text;
}

function setTextComponentValue(component: ProviderRowComponent, text: string): void {
    if (!isTextComponentView(component) || typeof component.setText !== "function") return;

    component.setText(text);
}

function fitProviderRow(layout: ProviderRowLayout, width: number): string {
    const availableWidth = Math.max(0, Math.floor(width));
    if (availableWidth === 0) return "";
    if (visibleWidth(layout.fullText) <= availableWidth) return layout.fullText;

    const gap = "  ";
    const gapWidth = visibleWidth(gap);
    const maximumProviderWidth = Math.max(1, Math.floor(availableWidth * 0.45));
    const provider = truncateToWidth(layout.providerText, maximumProviderWidth, "…");
    const modelWidth = Math.max(0, availableWidth - visibleWidth(provider) - gapWidth);
    const checkmarkWidth = visibleWidth(layout.checkmark);
    let model = truncateToWidth(layout.modelPrefix, modelWidth, "…");
    if (checkmarkWidth > 0 && checkmarkWidth < modelWidth) {
        model = `${truncateToWidth(layout.modelPrefix, modelWidth - checkmarkWidth, "…")}${layout.checkmark}`;
    }

    return truncateToWidth(`${model}${gap}${provider}`, availableWidth, "");
}

function isRenderableTextComponent(value: ProviderRowComponent): value is RenderableTextComponent {
    return isTextComponentView(value) && "render" in value && typeof value.render === "function";
}

function setResponsiveProviderRow(
    component: ProviderRowComponent,
    layout: ProviderRowLayout,
): void {
    providerRowLayoutByComponent.set(component, layout);
    setTextComponentValue(component, layout.fullText);

    if (!isRenderableTextComponent(component) || responsiveProviderRowComponents.has(component)) {
        return;
    }

    const originalRender = component.render.bind(component);

    component.render = function responsiveProviderRowRender(
        this: RenderableTextComponent,
        width: number,
    ): string[] {
        const currentLayout = providerRowLayoutByComponent.get(this);
        if (currentLayout !== undefined) {
            setTextComponentValue(this, fitProviderRow(currentLayout, width));
        }

        return originalRender(width);
    };
    responsiveProviderRowComponents.add(component);
}

function removeModelNameDetail(container: ListContainer): void {
    const detailIndex = container.children.findIndex(
        (child) => textComponentValue(child)?.includes("Model Name:") === true,
    );
    if (detailIndex === -1) return;

    container.children.splice(detailIndex, 1);

    const spacerIndex = detailIndex - 1;
    if (spacerIndex >= 0 && textComponentValue(container.children[spacerIndex]) === undefined) {
        container.children.splice(spacerIndex, 1);
    }
}

function removeModelCatalogStatusSpacer(container: ListContainer): void {
    const statusIndex = container.children.findIndex(
        (child) => textComponentValue(child)?.toLowerCase().includes("model catalog") === true,
    );
    if (statusIndex <= 0) return;
    if (textComponentValue(container.children[statusIndex - 1]) !== undefined) return;

    container.children.splice(statusIndex - 1, 1);
}

function takeScrollCounter(container: ListContainer): string | undefined {
    const scrollIndex = container.children.findIndex((child) => {
        const text = textComponentValue(child);
        return text !== undefined && /\(\d+\/\d+\)/.test(text);
    });
    if (scrollIndex === -1) return undefined;

    const text = textComponentValue(container.children[scrollIndex]);

    container.children.splice(scrollIndex, 1);

    return text;
}

export function setSearchCounter(
    input: Partial<SearchInput> | undefined,
    counter: string | undefined,
): void {
    if (input === undefined || typeof input.render !== "function") return;

    if (counter === undefined) searchCounterByInput.delete(input);
    else searchCounterByInput.set(input, counter.trim());

    if (input[SEARCH_COUNTER_RENDER_PATCH_KEY] === true) return;

    const originalRender = input.render;

    input.render = function renderWithSearchCounter(this: SearchInput, width: number): string[] {
        const lines = originalRender.call(this, width);
        const counterText = searchCounterByInput.get(this);
        const firstLine = lines.at(0);
        if (counterText === undefined || firstLine === undefined) return lines;

        const baseLine = firstLine.replace(/ +$/, "");
        const gap = width - visibleWidth(baseLine) - visibleWidth(counterText);
        if (gap < 1) return lines;

        return [`${baseLine}${" ".repeat(gap)}${counterText}`, ...lines.slice(1)];
    };
    input[SEARCH_COUNTER_RENDER_PATCH_KEY] = true;
}

export function visibleRows<Item>(
    items: readonly Item[],
    selectedIndex: number,
    maxVisible: number,
): Item[] {
    const startIndex = Math.max(
        0,
        Math.min(selectedIndex - Math.floor(maxVisible / 2), items.length - maxVisible),
    );
    return items.slice(startIndex, Math.min(startIndex + maxVisible, items.length));
}

export function formatProviderRows(
    container: ListContainer,
    rows: readonly ProviderRow[],
    widthRows: readonly ProviderRow[] = rows,
): string | undefined {
    if (rows.length === 0) {
        const counter = takeScrollCounter(container);

        removeModelNameDetail(container);
        removeModelCatalogStatusSpacer(container);

        return counter;
    }

    let modelWidth = Math.max(...rows.map((row) => visibleWidth(row.modelText)));
    if (widthRows.length > 0) {
        modelWidth = Math.max(...widthRows.map((row) => visibleWidth(row.modelText)));
    }

    rows.forEach((row, index) => {
        const component = container.children[index];
        const text = textComponentValue(component);
        if (text === undefined) return;

        const badge = `[${row.providerText}]`;
        const badgeIndex = text.lastIndexOf(badge);
        if (badgeIndex === -1) return;

        const suffix = text.slice(badgeIndex + badge.length);
        let checkmark = "";
        if (suffix.replace(ANSI_PATTERN, "").trim() === "✓") checkmark = suffix;

        const padding = " ".repeat(
            Math.max(0, modelWidth - visibleWidth(row.modelText) - visibleWidth(checkmark)) +
                PROVIDER_GAP_EXTRA_WIDTH,
        );
        const modelPrefix = text.slice(0, badgeIndex).trimEnd();
        setResponsiveProviderRow(component, {
            fullText: `${modelPrefix}${checkmark}${padding}${row.providerText}`,
            modelPrefix,
            checkmark,
            providerText: row.providerText,
        });
    });

    const counter = takeScrollCounter(container);

    removeModelNameDetail(container);
    removeModelCatalogStatusSpacer(container);

    return counter;
}
