export function includeSelectedItems<T>(
    currentItems: readonly T[],
    selectedItems: ReadonlyMap<string, T>,
    nameOf: (item: T) => string,
): T[] {
    const items = [...currentItems];
    const currentNames = new Set(items.map(nameOf));
    for (const selectedItem of selectedItems.values()) {
        if (!currentNames.has(nameOf(selectedItem))) items.push(selectedItem);
    }

    return items;
}

export function selectedOrCurrentItem<T>(
    currentItem: T,
    selectedItems: ReadonlyMap<string, T>,
    nameOf: (item: T) => string,
): T {
    return selectedItems.get(nameOf(currentItem)) ?? currentItem;
}
