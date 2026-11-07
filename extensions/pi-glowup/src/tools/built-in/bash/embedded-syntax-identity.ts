import type { EmbeddedProgram } from "./embedded-programs.ts";

const embeddedProgramKeys = new WeakMap<
    readonly EmbeddedProgram[],
    ReadonlyMap<EmbeddedProgram, string>
>();

export function programKey(program: EmbeddedProgram, programs: readonly EmbeddedProgram[]): string {
    let keys = embeddedProgramKeys.get(programs);
    if (keys === undefined) {
        const slots = new Map<EmbeddedProgram, number>();
        const siblings = new Map<EmbeddedProgram | undefined, number>();
        for (const item of programs) {
            const ordinal = siblings.get(item.parent) ?? 0;
            slots.set(item, ordinal);
            siblings.set(item.parent, ordinal + 1);
        }

        const next = new Map<EmbeddedProgram, string>();
        for (const item of programs) {
            const path: Array<[number, string, string]> = [];
            let current: EmbeddedProgram | undefined = item;
            while (current !== undefined) {
                path.push([slots.get(current) ?? 0, current.language, current.origin]);
                current = current.parent;
            }

            next.set(item, JSON.stringify(path));
        }

        keys = next;
        embeddedProgramKeys.set(programs, keys);
    }

    // Structural slots survive source-offset changes when an earlier program grows.
    // childHighlightOptions still observes each slot's source, cancelling obsolete jobs.
    return keys.get(program) ?? "standalone";
}
