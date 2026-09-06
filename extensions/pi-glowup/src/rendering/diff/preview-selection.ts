export const MUTATION_DIFF_PREVIEW_ROWS = 6;

export type SemanticDiffRowKind = "insert" | "delete" | "context" | "meta";

export function selectSemanticDiffIndices(
    kinds: readonly SemanticDiffRowKind[],
    lineBudget: number,
): readonly number[] {
    if (kinds.length <= lineBudget) {
        return kinds.map((_kind, index) => index);
    }

    const contentIndices: number[] = [];
    const changed: number[] = [];
    for (let index = 0; index < kinds.length; index += 1) {
        const kind = kinds[index];
        if (kind === undefined || kind === "meta") {
            continue;
        }
        contentIndices.push(index);
        if (kind === "insert" || kind === "delete") {
            changed.push(index);
        }
    }
    if (contentIndices.length <= lineBudget) {
        return contentIndices;
    }

    if (changed.length === 0) {
        const headCount = Math.ceil(lineBudget / 2);
        const tailCount = Math.floor(lineBudget / 2);
        return [
            ...contentIndices.slice(0, headCount),
            ...contentIndices.slice(contentIndices.length - tailCount),
        ];
    }

    const selected = new Set<number>();
    const changedHeadCount = Math.ceil(Math.min(lineBudget, changed.length) / 2);
    const changedTailCount = Math.min(lineBudget, changed.length) - changedHeadCount;
    for (const index of changed.slice(0, changedHeadCount)) {
        selected.add(index);
    }
    for (const index of changed.slice(changed.length - changedTailCount)) {
        selected.add(index);
    }

    let distance = 1;
    const firstChange = changed[0] ?? 0;
    const lastChange = changed.at(-1) ?? firstChange;
    while (selected.size < lineBudget && distance <= kinds.length) {
        for (const index of [firstChange - distance, lastChange + distance]) {
            if (
                index >= 0 &&
                index < kinds.length &&
                kinds[index] !== "meta" &&
                !selected.has(index)
            ) {
                selected.add(index);
                if (selected.size >= lineBudget) {
                    break;
                }
            }
        }
        distance += 1;
    }

    return [...selected].sort((left, right) => left - right);
}
