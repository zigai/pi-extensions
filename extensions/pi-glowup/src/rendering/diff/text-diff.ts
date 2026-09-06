export type DiffSection = {
    readonly path?: string;
    readonly lines: ReadonlyArray<string>;
    readonly lineCoordinates?: ReadonlyArray<DiffLineCoordinates | undefined>;
    readonly added: number;
    readonly removed: number;
};

export type DiffLineCoordinates = {
    readonly oldLine?: number;
    readonly newLine?: number;
};

const diffLinePattern = /^([+\- ])(\s*\d*)\s(.*)$/;

const ellipsisLinePattern = /^\s+\.\.\.$/;

const omissionLinePattern = /^\s+…(?:\s+.*)?$/u;

const addCountPattern = /^\+\s*\d+\s/;

const removeCountPattern = /^-\s*\d+\s/;

export function parseDiffSections(diffText: string, fallbackPath?: string): DiffSection[] {
    const normalized = diffText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const rawLines = normalized.split("\n");

    if (!rawLines.some((line) => line.startsWith("File: "))) {
        const lines = rawLines.filter((line) => line.length > 0);
        return [makeDiffSection(fallbackPath, lines)];
    }

    const sections: DiffSection[] = [];
    let currentPath: string | undefined;
    let currentLines: string[] = [];

    function flush(): void {
        if (currentPath === undefined && currentLines.length === 0) {
            return;
        }
        const lines = currentLines.filter((line) => line.length > 0);
        sections.push(makeDiffSection(currentPath, lines));
    }

    for (const line of rawLines) {
        if (line.startsWith("File: ")) {
            flush();
            currentPath = line.slice(6).trim();
            currentLines = [];
            continue;
        }
        currentLines.push(line);
    }
    flush();

    return sections;
}

/** Removes unchanged context rows while preserving changed-row coordinates and metadata. */
export function changedOnlyDiffSections(sections: ReadonlyArray<DiffSection>): DiffSection[] {
    return sections.flatMap((section) => {
        const retainedIndices = section.lines.flatMap((line, index) => {
            const parsed = parseDiffLine(line);
            return parsed?.kind === "context" || parsed?.kind === "ellipsis" ? [] : [index];
        });
        if (retainedIndices.length === 0) {
            return [];
        }

        const lines = retainedIndices.map((index) => section.lines[index] ?? "");
        const lineCoordinates = section.lineCoordinates;
        const changedSection: DiffSection = { ...section, lines };
        return lineCoordinates === undefined
            ? [changedSection]
            : [
                  {
                      ...changedSection,
                      lineCoordinates: retainedIndices.map((index) => lineCoordinates[index]),
                  },
              ];
    });
}

function makeDiffSection(path: string | undefined, lines: ReadonlyArray<string>): DiffSection {
    const visibleLines = trimEdgeEllipsisLines(lines);
    const section = {
        lines: visibleLines,
        lineCoordinates: deriveDiffLineCoordinates(visibleLines),
        added: visibleLines.filter((line) => addCountPattern.test(line)).length,
        removed: visibleLines.filter((line) => removeCountPattern.test(line)).length,
    };

    if (path === undefined) {
        return section;
    }
    return { ...section, path };
}

function deriveDiffLineCoordinates(
    lines: ReadonlyArray<string>,
): ReadonlyArray<DiffLineCoordinates | undefined> {
    let lineDelta = 0;
    return lines.map((line) => {
        const parsed = parseDiffLine(line);
        if (parsed === null || parsed.kind === "ellipsis" || parsed.kind === "omission") {
            return undefined;
        }
        const lineNumber = Number(normalizedDiffLineNumber(parsed.lineNumber));
        if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) {
            return undefined;
        }
        if (parsed.kind === "delete") {
            lineDelta -= 1;
            return { oldLine: lineNumber };
        }
        if (parsed.kind === "insert") {
            lineDelta += 1;
            return { newLine: lineNumber };
        }
        return { oldLine: lineNumber, newLine: lineNumber + lineDelta };
    });
}

function trimEdgeEllipsisLines(lines: ReadonlyArray<string>): string[] {
    let start = 0;
    let end = lines.length;
    while (ellipsisLinePattern.test(lines[start] ?? "")) {
        start += 1;
    }
    while (end > start && ellipsisLinePattern.test(lines[end - 1] ?? "")) {
        end -= 1;
    }
    return lines.slice(start, end);
}

export function parseDiffLine(line: string):
    | {
          readonly kind: "insert" | "delete" | "context";
          readonly lineNumber: string;
          readonly content: string;
      }
    | { readonly kind: "ellipsis" }
    | { readonly kind: "omission"; readonly content: string }
    | null {
    if (ellipsisLinePattern.test(line)) {
        return { kind: "ellipsis" };
    }
    if (omissionLinePattern.test(line)) {
        return { kind: "omission", content: line.trimStart() };
    }

    const match = diffLinePattern.exec(line);
    if (!match) {
        return null;
    }

    let kind: "insert" | "delete" | "context" = "context";
    if (match[1] === "+") {
        kind = "insert";
    }
    if (match[1] === "-") {
        kind = "delete";
    }

    return {
        kind,
        lineNumber: match[2] ?? "",
        content: match[3] ?? "",
    };
}

export function normalizedDiffLineNumber(lineNumber: string): string {
    return lineNumber.trim();
}
