import { mentionPattern, parseMentionName } from "./mention-syntax.ts";

export type MentionColorContext = {
    readonly ui: {
        readonly theme: {
            fg(role: string, text: string): string;
        };
    };
};

export function colorMentions(
    line: string,
    ctx: MentionColorContext,
    trigger: string,
    knownNames: ReadonlySet<string>,
): string {
    if (!line.includes(trigger) || knownNames.size === 0) return line;

    return line.replace(
        mentionPattern(trigger),
        (
            match: string,
            leading: string,
            quotedName: string | undefined,
            unquotedName: string | undefined,
        ) => {
            const parsed = parseMentionName(quotedName, unquotedName, knownNames);
            if (parsed === undefined) return match;

            const mentionEnd = match.length - parsed.suffix.length;
            const mentionText = match.slice(leading.length, mentionEnd);
            return `${leading}${ctx.ui.theme.fg("accent", mentionText)}${parsed.suffix}`;
        },
    );
}

const ANSI_ESCAPE_PATTERN = new RegExp(
    `${String.fromCharCode(27)}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])`,
    "g",
);

function stripAnsi(value: string): string {
    return value.replace(ANSI_ESCAPE_PATTERN, "");
}

export function autocompleteStartIndex(renderedLines: string[]): number {
    for (let index = renderedLines.length - 1; index >= 0; index -= 1) {
        const line = renderedLines.at(index);
        if (line !== undefined && stripAnsi(line).startsWith("─")) return index + 1;
    }

    return renderedLines.length;
}
