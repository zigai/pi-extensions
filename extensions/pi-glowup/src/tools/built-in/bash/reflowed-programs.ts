import type { EmbeddedProgram } from "./embedded-programs.ts";

type ProgramAnchor = {
    readonly program: EmbeddedProgram;
    readonly start: number;
};

/** Reflow changes only shell whitespace, never embedded source. Preserve its
 * original parse/decoding instead of parsing display-only leading operators. */
export function reflowedEmbeddedPrograms(
    source: string,
    display: string,
    programs: readonly EmbeddedProgram[],
): readonly EmbeddedProgram[] | undefined {
    if (source === display || programs.length === 0) return programs;

    const anchors = new Map<number, ProgramAnchor[]>();
    for (const program of programs) {
        const offset = source.slice(program.start, program.end).search(/\S/u);
        let at = program.start + offset;
        let start = program.start;
        if (offset < 0) {
            // Blank heredocs still occupy structural sibling slots. Anchor their
            // preserved header and verify the entire gap through the body.
            at = program.start - 1;
            while (at >= 0 && /\s/u.test(source[at] ?? "")) at--;

            if (at < 0) continue;
            start = at;
        }

        const matches = anchors.get(at) ?? [];
        matches.push({ program, start });
        anchors.set(at, matches);
    }

    const shifts = new Map<EmbeddedProgram, number>();
    let left = 0;
    let right = 0;
    while (left < source.length || right < display.length) {
        while (left < source.length && /\s/u.test(source[left] ?? "")) left++;

        while (right < display.length && /\s/u.test(display[right] ?? "")) right++;

        if (source[left] !== display[right]) return undefined;

        for (const { program, start } of anchors.get(left) ?? []) {
            const shift = right - left;
            if (
                display.slice(start + shift, program.end + shift) ===
                source.slice(start, program.end)
            )
                shifts.set(program, shift);
        }

        left++;
        right++;
    }

    const mapped = new Map<EmbeddedProgram, EmbeddedProgram | undefined>();
    const project = (program: EmbeddedProgram): EmbeddedProgram | undefined => {
        if (mapped.has(program)) return mapped.get(program);

        const shift = shifts.get(program);
        if (shift === undefined) return undefined;

        let parent;
        if (program.parent !== undefined) {
            parent = project(program.parent);
            if (parent === undefined) return undefined;
        }

        let localShift = 0;
        if (program.parent === undefined) localShift = shift;

        const result: EmbeddedProgram = {
            ...program,
            start: program.start + shift,
            end: program.end + shift,
            localStart: program.localStart + localShift,
            localEnd: program.localEnd + localShift,
            ...(parent !== undefined && { parent }),
            ...(program.characters !== undefined && {
                characters: program.characters.map((span) => ({
                    ...span,
                    start: span.start + shift,
                    end: span.end + shift,
                })),
            }),
            ...(program.localCharacters !== undefined && {
                localCharacters: program.localCharacters.map((span) => ({
                    ...span,
                    start: span.start + localShift,
                    end: span.end + localShift,
                })),
            }),
        };

        mapped.set(program, result);

        return result;
    };

    return programs.flatMap((program) => {
        const result = project(program);
        if (result === undefined) return [];

        return [result];
    });
}
