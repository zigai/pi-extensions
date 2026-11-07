import { analyzeBashCommand } from "./command.ts";
import type { EmbeddedProgram } from "./embedded-programs.ts";
import { programKey } from "./embedded-syntax-identity.ts";
import type { ScriptInvocation } from "./invocation.ts";
import {
    prepareSyntaxCode,
    type PreparedSyntaxCode,
} from "../../../rendering/syntax/highlighter.ts";

type PreparedChildSyntax = {
    readonly source: string;
    readonly syntax: PreparedSyntaxCode;
};

type PreparedScriptVariant = {
    readonly origin: string;
    readonly standalone?: PreparedSyntaxCode;
    readonly programs?: readonly EmbeddedProgram[];
    readonly children: ReadonlyMap<string, PreparedChildSyntax>;
};

// The bounded preview store and live components own invocation lifetimes. Neither
// this registry nor prepared syntax adds a strong global source cache.
const preparedScripts = new WeakMap<ScriptInvocation, ReadonlyMap<string, PreparedScriptVariant>>();

export function getPreparedScriptSyntax(
    invocation: ScriptInvocation,
): PreparedScriptVariant | undefined {
    return preparedScripts.get(invocation)?.get(invocation.code);
}

export function inheritPreparedScriptSyntax(
    target: ScriptInvocation,
    source: ScriptInvocation,
): void {
    const variants = preparedScripts.get(source);
    if (variants?.has(target.code) === true) preparedScripts.set(target, variants);
}

/** Keep only the raw view's capabilities, never a chain of older formatted widths. */
export function carryRawScriptSyntax(
    target: ScriptInvocation,
    source: ScriptInvocation,
    rawSource: string,
): void {
    const variants = preparedScripts.get(source);
    if (variants === undefined) return;

    const combined = new Map(preparedScripts.get(target));
    for (const [code, variant] of variants)
        if (variant.origin === rawSource && !combined.has(code)) combined.set(code, variant);

    preparedScripts.set(target, combined);
}

export async function prepareScriptCallSyntax(
    invocation: ScriptInvocation,
    signal: AbortSignal | undefined,
    resolvePrograms?: (source: string) => Promise<readonly EmbeddedProgram[] | undefined>,
): Promise<void> {
    const isAborted = (): boolean => signal?.aborted === true;

    if (invocation.language !== "bash") {
        const standalone = await prepareSyntaxCode(invocation.code, invocation.language, signal);
        if (standalone !== undefined)
            preparedScripts.set(
                invocation,
                new Map<string, PreparedScriptVariant>([
                    [
                        invocation.code,
                        {
                            origin: invocation.code,
                            standalone,
                            children: new Map<string, PreparedChildSyntax>(),
                        },
                    ],
                ]),
            );

        return;
    }

    if (resolvePrograms === undefined || isAborted()) return;

    const bases = new Set([invocation.code, invocation.code.replace(/^[ \t\n]+/u, "")]);
    const parsed = new Map<string, readonly EmbeddedProgram[]>();
    const variants = new Set(bases);
    for (const source of bases) {
        const programs = await resolvePrograms(source);
        if (programs === undefined || isAborted()) return;

        parsed.set(source, programs);

        // Prepare both supported operator placements before publication. Width
        // wrapping remains the renderer's responsibility, not the formatter's.
        for (const position of ["leading", "trailing"] as const) {
            const analysis = analyzeBashCommand(source, position, programs);
            const reflowed = analysis.reflowedCommand;
            if (reflowed !== undefined) {
                variants.add(reflowed);

                if (analysis.reflowedPrograms !== undefined)
                    parsed.set(reflowed, analysis.reflowedPrograms);
            }
        }
    }

    const completed = new Map<string, Map<string, PreparedSyntaxCode | undefined>>();
    const prepared = new Map<string, PreparedScriptVariant>();
    for (const source of variants) {
        let programs = parsed.get(source);
        programs ??= await resolvePrograms(source);
        if (programs === undefined || isAborted()) return;

        const children = new Map<string, PreparedChildSyntax>();
        for (const program of programs) {
            if (program.expandable || program.language === "bash") continue;

            let language = completed.get(program.language);
            if (language === undefined) {
                language = new Map();
                completed.set(program.language, language);
            }

            if (!language.has(program.code))
                language.set(
                    program.code,
                    await prepareSyntaxCode(program.code, program.language, signal),
                );

            const syntax = language.get(program.code);
            if (syntax !== undefined)
                children.set(programKey(program, programs), { source: program.code, syntax });
        }

        prepared.set(source, { origin: invocation.code, programs, children });
    }

    if (!isAborted()) preparedScripts.set(invocation, prepared);
}
