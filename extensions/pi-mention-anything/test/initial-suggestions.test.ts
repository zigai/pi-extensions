import { expect, test } from "vitest";
import { rankInitialSuggestions } from "../src/initial-suggestions.ts";

const alphabetical = { strategy: "alphabetical", pinned: [] } as const;
const nameOf = (name: string): string => name;

function originalNameOrder(names: readonly string[]): string[] {
    return [...names].sort((left, right) =>
        left.localeCompare(right, undefined, { sensitivity: "base" }),
    );
}

test.each([
    ["zeta", "Ångström", "apple", "Beta", "Résumé", "工具"],
    ["résumé", "RESUME", "resume", "re\u0301sume\u0301", "Resume"],
    ["a-10", "a-2", "a-1", "A-2", "ä-2", "a_2", "a 2"],
    ["👩‍💻", "alpha", "😀", "Αθήνα", "東京", "Ångström", "I", "ı", "İ", "i"],
])("alphabetical suggestions preserve the locale's base-sensitivity order: %j", (...names) => {
    const source = Object.freeze(names);
    const result = rankInitialSuggestions(source, nameOf, alphabetical, new Map(), 0);
    expect(result).toEqual(originalNameOrder(source));
    expect(source).toEqual(names);
});

test("alphabetical pins and priorities precede collation, with source-order ties", () => {
    const source = [
        { id: 1, name: "Résumé", priority: 1 },
        { id: 2, name: "resume", priority: 1 },
        { id: 3, name: "Zulu", priority: 0 },
        { id: 4, name: "Apple", priority: 1 },
        { id: 5, name: "Pinned", priority: 10 },
    ];

    const result = rankInitialSuggestions(
        source,
        (item) => item.name,
        { strategy: "alphabetical", pinned: ["Pinned"] },
        new Map(),
        0,
        (item) => item.priority,
    );
    expect(result.map((item) => item.id)).toEqual([5, 3, 4, 1, 2]);
    expect(source.map((item) => item.id)).toEqual([1, 2, 3, 4, 5]);
});

test("successive rankings observe changed names and leave previous output order intact", () => {
    const first = { name: "Alpha" };
    const second = { name: "Beta" };
    const source = [first, second];
    const previous = rankInitialSuggestions(
        source,
        (item) => item.name,
        alphabetical,
        new Map(),
        0,
    );
    first.name = "Zulu";
    const next = rankInitialSuggestions(source, (item) => item.name, alphabetical, new Map(), 0);
    expect(previous).toEqual([first, second]);
    expect(next).toEqual([second, first]);
    expect(source).toEqual([first, second]);
});
