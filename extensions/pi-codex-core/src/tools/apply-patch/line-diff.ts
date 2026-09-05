export type PatchLineEdit = {
    readonly kind: "context" | "addition" | "deletion";
    readonly text: string;
};

function makeLcsTable(oldLines: readonly string[], newLines: readonly string[]): number[][] {
    const table = Array.from({ length: oldLines.length + 1 }, () =>
        Array.from<number>({ length: newLines.length + 1 }).fill(0),
    );
    for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
        for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
            const row = table[oldIndex];
            const nextRow = table[oldIndex + 1];
            if (row === undefined || nextRow === undefined) continue;
            row[newIndex] =
                oldLines[oldIndex] === newLines[newIndex]
                    ? (nextRow[newIndex + 1] ?? 0) + 1
                    : Math.max(nextRow[newIndex] ?? 0, row[newIndex + 1] ?? 0);
        }
    }
    return table;
}

export function diffPatchLines(
    oldLines: readonly string[],
    newLines: readonly string[],
): readonly PatchLineEdit[] {
    const table = makeLcsTable(oldLines, newLines);
    const lines: PatchLineEdit[] = [];
    let oldIndex = 0;
    let newIndex = 0;
    while (oldIndex < oldLines.length && newIndex < newLines.length) {
        const oldLine = oldLines[oldIndex] ?? "";
        const newLine = newLines[newIndex] ?? "";
        if (oldLine === newLine) {
            lines.push({ kind: "context", text: oldLine });
            oldIndex += 1;
            newIndex += 1;
        } else if (
            (table[oldIndex + 1]?.[newIndex] ?? 0) >= (table[oldIndex]?.[newIndex + 1] ?? 0)
        ) {
            lines.push({ kind: "deletion", text: oldLine });
            oldIndex += 1;
        } else {
            lines.push({ kind: "addition", text: newLine });
            newIndex += 1;
        }
    }
    while (oldIndex < oldLines.length) {
        lines.push({ kind: "deletion", text: oldLines[oldIndex] ?? "" });
        oldIndex += 1;
    }
    while (newIndex < newLines.length) {
        lines.push({ kind: "addition", text: newLines[newIndex] ?? "" });
        newIndex += 1;
    }
    return lines;
}
