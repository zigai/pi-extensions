import { fc, it } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import {
    selectSemanticDiffIndices,
    type SemanticDiffRowKind,
} from "../../../src/rendering/diff/preview-selection.ts";
import { propertyReplayParameters } from "../../support/property-replay.ts";

const kindArbitrary = fc.constantFrom<SemanticDiffRowKind>("insert", "delete", "context", "meta");
const scenarioArbitrary = fc.record({
    kinds: fc.array(kindArbitrary, { maxLength: 96 }),
    budget: fc.integer({ min: 0, max: 12 }),
});

describe("semantic diff selection", () => {
    it.prop([scenarioArbitrary], propertyReplayParameters())(
        "keeps bounded chronological indices and prioritizes all changes when they fit",
        ({ kinds, budget }) => {
            const selected = selectSemanticDiffIndices(kinds, budget);
            expect(selected.length).toBeLessThanOrEqual(budget);
            expect([...new Set(selected)]).toEqual(selected);
            expect([...selected].sort((left, right) => left - right)).toEqual(selected);

            for (const index of selected) {
                expect(index).toBeGreaterThanOrEqual(0);
                expect(index).toBeLessThan(kinds.length);
                if (kinds.length > budget) {
                    expect(kinds[index]).not.toBe("meta");
                }
            }

            const changed = kinds.flatMap((kind, index) =>
                kind === "insert" || kind === "delete" ? [index] : [],
            );
            if (changed.length <= budget) {
                for (const index of changed) {
                    expect(selected).toContain(index);
                }
            }

            if (kinds.length <= budget) {
                expect(selected).toEqual(kinds.map((_kind, index) => index));
            }
        },
    );

    it.prop([scenarioArbitrary], propertyReplayParameters())(
        "is invariant under exchanging insertion and deletion labels",
        ({ kinds, budget }) => {
            const exchanged = kinds.map((kind): SemanticDiffRowKind => {
                if (kind === "insert") return "delete";
                if (kind === "delete") return "insert";

                return kind;
            });
            expect(selectSemanticDiffIndices(exchanged, budget)).toEqual(
                selectSemanticDiffIndices(kinds, budget),
            );
        },
    );

    it("keeps both ends of a context-only preview without metadata rows", () => {
        expect(
            selectSemanticDiffIndices(
                ["meta", "context", "context", "context", "context", "context", "meta"],
                3,
            ),
        ).toEqual([1, 2, 5]);
    });

    it("retains distant changed rows instead of spending their budget on context", () => {
        expect(
            selectSemanticDiffIndices(
                ["context", "insert", "context", "context", "context", "delete", "meta"],
                2,
            ),
        ).toEqual([1, 5]);
    });
});
