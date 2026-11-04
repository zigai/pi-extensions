import type { CorrectionRule, InputCorrectionsSettings } from "./policy-input.ts";

export type { CorrectionRule, InputCorrectionsSettings } from "./policy-input.ts";

// Bounds apply to intermediate output too; never truncate a user's prompt.
export const MAX_INPUT_LENGTH = 65_536;
export const MAX_REGEX_INPUT_LENGTH = 2048;
const MAX_OUTPUT_LENGTH = 131_072;

export type CorrectionEngine = {
    diagnostics: string[];
    correct(this: void, text: string): string;
};

type Range = { start: number; end: number };

type CompiledRule = { pattern: RegExp; replacement: string } & (
    | { kind: "literal" | "word"; find: string }
    | { kind: "regex" }
);

function wordAfter(text: string, index: number): boolean {
    return /^[\p{L}\p{N}\p{M}_]/u.test(text.slice(index, index + 2));
}

function wordBefore(text: string, index: number): boolean {
    if (index <= 0) return false;

    let start = index - 1;
    const pair = text.codePointAt(index - 2);
    if (pair !== undefined && pair > 0xffff) start -= 1;

    return wordAfter(text, start);
}

function escaped(text: string, index: number): boolean {
    let count = 0;
    for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) count += 1;

    return count % 2 === 1;
}

function apostropheDelimiter(text: string, index: number): boolean {
    return !escaped(text, index) && !(wordBefore(text, index) && wordAfter(text, index + 1));
}

function protectedRanges(text: string): Range[] {
    const ranges: Range[] = [];
    const lastCandidate = text.trimEnd().length - 1;

    for (const match of text.matchAll(/(?:\b[a-z][a-z\d+.-]*:\/\/|\bwww\.)[^\s<>]+/giu)) {
        ranges.push({ start: match.index, end: match.index + match[0].length });
    }

    // Command-line flags are literals, even in otherwise ordinary prose.
    for (const match of text.matchAll(/(?:^|\s)(--?[\p{L}\p{N}_][^\s]*)/gu)) {
        ranges.push({ start: match.index, end: match.index + match[0].length });
    }

    // Protect path-like tokens (including relative paths and ordinary filenames).
    for (const match of text.matchAll(
        /(?:^|[\s("'`])((?:[a-z]:[\\/]|~?[\\/]|\.{1,2}[\\/]|[\w@.-]+[\\/])[^\s<>"`]+|[\w@.-]+\.[a-z][a-z\d_-]*|\.[\w.-]+)(?=$|[\s).,:!?"'`])/giu,
    )) {
        const token = match.at(1);
        if (token === undefined) continue;

        ranges.push({
            start: match.index + match[0].length - token.length,
            end: match.index + match[0].length,
        });
    }

    // Backticks, paired quoted literals, and unmatched opening quotes protect their contents.
    for (let i = 0; i < text.length; i += 1) {
        const quote = text[i];
        if (quote !== "`" && quote !== '"' && quote !== "'" && quote !== "“" && quote !== "‘")
            continue;

        let closingQuote = quote;
        if (quote === "“") closingQuote = "”";
        if (quote === "‘") closingQuote = "’";
        if (escaped(text, i) || (quote === "'" && !apostropheDelimiter(text, i))) continue;

        // A final unmatched apostrophe is the built-in's candidate, not an opening quote.
        if (quote === "'" && i === lastCandidate) continue;

        let end = i + 1;
        while (end < text.length) {
            if (
                text[end] === closingQuote &&
                !escaped(text, end) &&
                (quote !== "'" || apostropheDelimiter(text, end))
            )
                break;

            end += 1;
        }

        ranges.push({ start: i, end: Math.min(end + 1, text.length) });
        i = end;
    }

    // Merge once so overlap checks remain logarithmic even for many short protected spans.
    const merged: Range[] = [];
    for (const range of ranges.sort((left, right) => left.start - right.start)) {
        const last = merged.at(-1);
        if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end);
        else merged.push(range);
    }

    return merged;
}

function overlaps(ranges: Range[], start: number, end: number): boolean {
    let low = 0;
    let high = ranges.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const range = ranges.at(middle);
        if (range === undefined) return false;

        if (range.end <= start) low = middle + 1;
        else high = middle;
    }

    const candidate = ranges.at(low);
    return candidate !== undefined && candidate.start < end;
}

function prose(text: string): boolean {
    // Whole-prompt exclusions intentionally favor false negatives over editing executable input.
    return (
        !/^\s*[/!]/u.test(text) &&
        !/```|~~~/u.test(text) &&
        !/(?:^|\n)(?: {4}|\t)|[{};]|(?:=>)|(?:\b(?:const|let|var|function|import|export|SELECT|INSERT)\s)/u.test(
            text,
        )
    );
}

function trailingQuestionMark(text: string, ranges: Range[]): string {
    const trimmed = text.trimEnd();
    const last = trimmed.length - 1;
    if (text[last] !== "'" || escaped(text, last) || overlaps(ranges, last, last + 1)) return text;

    let opening = false;
    for (let i = 0; i < last; i += 1) {
        if (text[i] === "'" && apostropheDelimiter(text, i)) opening = !opening;
    }

    // Require some prose, not an isolated punctuation mark or plural possessive token.
    if (opening || !/\p{L}/u.test(text) || !/\s/u.test(trimmed)) return text;
    return `${text.slice(0, last)}?${text.slice(last + 1)}`;
}

/** Deliberately small regex language: no groups, alternatives, backreferences, or bounded repeats.
 * At most one variable quantifier avoids combinatorial backtracking. Minimum width must be positive.
 */
function safeRegex(source: string): boolean {
    let width = 0;
    let previousWidth = 0;
    let quantified = false;
    for (let i = 0; i < source.length; i += 1) {
        const character = source.charAt(i);
        if (character === "\\") {
            const next = source.charAt(++i);
            if (next === "" || /[\dpPkKcux]/u.test(next)) return false;

            previousWidth = 1;
            if (next === "b" || next === "B") previousWidth = 0;
        } else if (character === "[") {
            i += 1;
            while (i < source.length && source[i] !== "]") {
                if (source[i] === "\\") i += 1;
                i += 1;
            }

            if (i >= source.length) return false;

            previousWidth = 1;
        } else if (character === "*" || character === "+" || character === "?") {
            if (quantified || previousWidth === 0) return false;

            quantified = true;

            if (character !== "+") width -= previousWidth;
            previousWidth = 0;
            continue;
        } else {
            if ("()|{}".includes(character)) return false;

            previousWidth = 1;
            if (character === "^" || character === "$") previousWidth = 0;
        }

        width += previousWidth;
    }

    return width > 0;
}

function compileRule(rule: CorrectionRule): CompiledRule | undefined {
    if (rule.find.length === 0 || rule.find.length > 128 || rule.replacement.length > 1024)
        return undefined;

    const kind = rule.kind ?? "literal";
    if (kind === "literal" || kind === "word") {
        if (kind === "word" && !/^[\p{L}\p{N}\p{M}_]+$/u.test(rule.find)) return undefined;

        return {
            pattern: new RegExp(rule.find.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"),
            replacement: rule.replacement,
            kind,
            find: rule.find,
        };
    }

    const flags = rule.flags ?? "g";
    if (!/^[gimsu]*$/u.test(flags) || new Set(flags).size !== flags.length || !safeRegex(rule.find))
        return undefined;

    try {
        return {
            pattern: new RegExp(rule.find, flags),
            replacement: rule.replacement,
            kind: "regex",
        };
    } catch {
        return undefined;
    }
}

/** Pure reusable engine. Invalid rules are skipped, with value-free diagnostics by rule position. */
export function createCorrectionEngine(settings: InputCorrectionsSettings): CorrectionEngine {
    const diagnostics: string[] = [];
    const rules: CompiledRule[] = [];
    for (const [index, rule] of settings.rules.entries()) {
        if (rule.enabled === false) continue;

        const compiled = compileRule(rule);
        if (compiled === undefined)
            diagnostics.push(
                `Rule ${index + 1} is invalid or outside the safe pattern subset; skipped.`,
            );
        else rules.push(compiled);
    }

    return {
        diagnostics,
        correct(this: void, text: string) {
            if (!settings.enabled || text.length > MAX_INPUT_LENGTH || !prose(text)) return text;

            let result = text;
            let ranges: Range[] | undefined;
            let checkedProse = text;

            if (settings.trailingQuestionMark && result.trimEnd().endsWith("'")) {
                ranges = protectedRanges(result);

                const corrected = trailingQuestionMark(result, ranges);
                if (corrected !== result) {
                    result = corrected;
                    ranges = undefined;
                }
            }

            for (const rule of rules) {
                if (result.length > MAX_INPUT_LENGTH) break;

                // Classification is valid until a preceding rule actually changes the text.
                if (result !== checkedProse) {
                    if (!prose(result)) break;

                    checkedProse = result;
                }

                if (rule.kind === "regex" && result.length > MAX_REGEX_INPUT_LENGTH) continue;
                if (rule.kind !== "regex" && !result.includes(rule.find)) continue;

                rule.pattern.lastIndex = 0;

                const budget = { length: result.length, overflow: false };
                const next = result.replace(rule.pattern, (match: string, offset: number) => {
                    if (
                        budget.overflow ||
                        match.length === 0 ||
                        (rule.kind === "word" &&
                            (wordBefore(result, offset) ||
                                wordAfter(result, offset + match.length)))
                    )
                        return match;

                    // Most rules do not match. Parse protected spans only for a viable match,
                    // then share them with later rules while the text remains byte-identical.
                    ranges ??= protectedRanges(result);
                    if (overlaps(ranges, offset, offset + match.length)) return match;

                    budget.length += rule.replacement.length - match.length;
                    if (budget.length > MAX_OUTPUT_LENGTH) {
                        budget.overflow = true;
                        return match;
                    }

                    return rule.replacement;
                });

                if (budget.overflow) return text;

                if (next !== result) {
                    result = next;
                    ranges = undefined;
                }
            }

            return result;
        },
    };
}
