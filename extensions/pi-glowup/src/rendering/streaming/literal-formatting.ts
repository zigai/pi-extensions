import type { StatementLiteral } from "./statement-literals.ts";

function escapePattern(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Collapse opaque literal payloads before any indentation transform. Restore
 * them only after extraction and final indentation, preserving their exact bytes. */
export function maskStatementLiterals(
    source: string,
    start: number,
    end: number,
    language: string,
    literals: readonly StatementLiteral[],
    marker: string,
) {
    let code = "";
    let offset = start;
    const replacements: { readonly pattern: RegExp; readonly original: string }[] = [];
    for (const [index, literal] of literals.entries()) {
        if (literal.start < offset || literal.end > end) continue;

        const original = source.slice(literal.start, literal.end);
        const sentinel = `${marker}literal${index}`;
        const escaped = escapePattern(sentinel);
        let placeholder = `"${sentinel}"`;
        let pattern = new RegExp(`(["'])${escaped}\\1`, "u");

        if (literal.kind === "heredoc" && literal.delimiter !== undefined) {
            placeholder = `${sentinel}\n${literal.delimiter}`;
            pattern = new RegExp(
                `^[\\t ]*${escaped}\\r?\\n[\\t ]*${escapePattern(literal.delimiter)}(?=\\r?$|\\n)`,
                "mu",
            );
        } else if (literal.kind === "template") {
            placeholder = `\`${sentinel}\``;
            pattern = new RegExp(`\`${escaped}\``, "u");
        } else if (language === "python") {
            const opening = /^([rubf]*)("""|'''|"|')/iu.exec(original);
            if (opening === null) continue;

            const prefix = opening[1] ?? "";
            const quote = opening[2] ?? '"';
            placeholder = prefix + quote + sentinel + quote;
            pattern = new RegExp(`(?:[rubf]*)("""|'''|"|')${escaped}\\1`, "iu");
        }

        code += source.slice(offset, literal.start) + placeholder;
        offset = literal.end;
        replacements.push({ pattern, original });
    }

    code += source.slice(offset, end);

    return {
        code,
        restore(formatted: string): string | undefined {
            let restored = formatted;

            for (const { pattern, original } of replacements) {
                if (!pattern.test(restored)) return undefined;

                restored = restored.replace(pattern, () => original);
            }

            if (restored.includes(`${marker}literal`)) return undefined;
            return restored;
        },
    };
}
