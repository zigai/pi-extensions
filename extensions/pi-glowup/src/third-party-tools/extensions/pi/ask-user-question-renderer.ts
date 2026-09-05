import {
    emptyComponent,
    renderGlowupOutput,
    type GlowupRenderTheme,
} from "../../../rendering/core.ts";
import {
    shouldDeferSimpleToolCall,
    toolStatusLabel,
    type ToolLabelMode,
    type ToolLifecycleLabels,
} from "../../../rendering/status-labels.ts";
import type {
    ThirdPartyToolRenderContext,
    ThirdPartyToolRenderer,
    ThirdPartyToolResult,
} from "../../types.ts";
import {
    callState,
    DEFAULT_TOOL_CALL_PREVIEW_LINES,
    renderSimpleResult,
    renderThirdPartyCall,
} from "../../call-rendering.ts";
import { previewArgsForContext, textOutput } from "../../previews.ts";
import { jsonValueParser, type JsonValue } from "../../../json-value.ts";
import { stringParser } from "../../../json-scalar.ts";
import {
    getArray,
    getBoolean,
    getNonEmptyString,
    getString,
    isDefined,
    isNonEmptyString,
    jsonObjectParser,
} from "../../tool-values.ts";

type AskUserQuestionOption = {
    readonly label: string;
    readonly description: string | undefined;
    readonly hasPreview: boolean;
};

type AskUserQuestionItem = {
    readonly header: string | undefined;
    readonly question: string;
    readonly options: ReadonlyArray<AskUserQuestionOption>;
    readonly multiSelect: boolean;
};

type AskUserQuestionAnswer = {
    readonly question: string;
    readonly answer: string;
};

function parseAskUserQuestionOption(value: unknown): AskUserQuestionOption | undefined {
    const record = jsonObjectParser.parse(value);
    if (record === undefined) {
        return undefined;
    }

    const label = getNonEmptyString(record, "label");
    if (label === undefined) {
        return undefined;
    }

    return {
        label,
        description: getString(record, "description"),
        hasPreview: getNonEmptyString(record, "preview") !== undefined,
    };
}

function parseAskUserQuestionItem(value: unknown): AskUserQuestionItem | undefined {
    const record = jsonObjectParser.parse(value);
    if (record === undefined) {
        return undefined;
    }

    const question = getNonEmptyString(record, "question");
    if (question === undefined) {
        return undefined;
    }

    const rawOptions = getArray(record, "options") ?? [];
    const options = rawOptions.map(parseAskUserQuestionOption).filter(isDefined);
    return {
        header: getNonEmptyString(record, "header"),
        question,
        options,
        multiSelect: getBoolean(record, "multiSelect") === true,
    };
}

function parseAskUserQuestions(args: unknown): ReadonlyArray<AskUserQuestionItem> {
    const record = jsonObjectParser.parse(args);
    if (record === undefined) {
        return [];
    }

    const rawQuestions = getArray(record, "questions") ?? [];
    return rawQuestions.map(parseAskUserQuestionItem).filter(isDefined);
}

function formatAskUserQuestionHeadline(
    theme: GlowupRenderTheme,
    item: AskUserQuestionItem,
    index: number,
    totalQuestions: number,
): string {
    const header = item.header ?? (totalQuestions > 1 ? `Question ${index + 1}` : undefined);
    if (header === undefined) {
        return item.question;
    }
    return `${theme.fg("accent", header)} ${theme.fg("dim", "·")} ${item.question}`;
}

function formatAskUserQuestionOptions(
    theme: GlowupRenderTheme,
    item: AskUserQuestionItem,
    expanded: boolean,
): ReadonlyArray<string> {
    if (item.options.length === 0) {
        return [];
    }

    const choiceLabel = item.multiSelect ? "Choose any" : "Choose one";
    if (!expanded) {
        const labels = item.options.map((option) => option.label).join(" · ");
        return [`${theme.fg("muted", `${choiceLabel}:`)} ${labels}`];
    }

    return [
        theme.fg("muted", `${choiceLabel}:`),
        ...item.options.map((option) => {
            const description = isNonEmptyString(option.description)
                ? ` — ${option.description}`
                : "";
            const preview = option.hasPreview ? theme.fg("dim", " (preview)") : "";
            return `  ${theme.fg("dim", "○")} ${option.label}${description}${preview}`;
        }),
    ];
}

function summarizeAskUserQuestionArgs(
    args: JsonValue | undefined,
    theme: GlowupRenderTheme,
    expanded: boolean,
    context: ThirdPartyToolRenderContext,
): string | undefined {
    if (context.isPartial || !context.argsComplete) {
        return previewArgsForContext(args, context);
    }

    const questions = parseAskUserQuestions(args);
    if (questions.length === 0) {
        return previewArgsForContext(args, context);
    }

    const lines: string[] = [];
    for (const [index, item] of questions.entries()) {
        if (index > 0) {
            lines.push("");
        }
        lines.push(formatAskUserQuestionHeadline(theme, item, index, questions.length));
        lines.push(...formatAskUserQuestionOptions(theme, item, expanded));
    }

    return lines.join("\n");
}

const ASK_USER_QUESTION_ANSWER_PATTERN =
    /"(?<rawQuestion>(?:\\.|[^"\\])*)"\s*=\s*"(?<rawAnswer>(?:\\.|[^"\\])*)"/gu;

function decodeAskUserQuotedText(rawText: string): string {
    try {
        const parsed = stringParser.parse(JSON.parse(`"${rawText}"`));
        if (parsed !== undefined) {
            return parsed;
        }
    } catch {
        return rawText.replace(/\\"/gu, '"').replace(/\\\\/gu, "\\");
    }
    return rawText;
}

function parseAskUserQuestionAnswers(output: string): ReadonlyArray<AskUserQuestionAnswer> {
    const answers: AskUserQuestionAnswer[] = [];
    for (const match of output.matchAll(ASK_USER_QUESTION_ANSWER_PATTERN)) {
        const rawQuestion = match.groups?.rawQuestion;
        const rawAnswer = match.groups?.rawAnswer;
        if (rawQuestion === undefined || rawAnswer === undefined) {
            continue;
        }

        answers.push({
            question: decodeAskUserQuotedText(rawQuestion),
            answer: decodeAskUserQuotedText(rawAnswer),
        });
    }

    return answers;
}

function findAskUserQuestionItem(
    questions: ReadonlyArray<AskUserQuestionItem>,
    answer: AskUserQuestionAnswer,
    answerIndex: number,
): AskUserQuestionItem | undefined {
    return questions.find((item) => item.question === answer.question) ?? questions[answerIndex];
}

function summarizeAskUserQuestionResult(
    result: ThirdPartyToolResult,
    args: JsonValue | undefined,
    theme: GlowupRenderTheme,
    expanded: boolean,
): string | undefined {
    const output = textOutput(result);
    if (output === undefined || output.length === 0) {
        return undefined;
    }

    const answers = parseAskUserQuestionAnswers(output);
    if (answers.length === 0) {
        return undefined;
    }

    const questions = parseAskUserQuestions(args);
    const lines: string[] = [];
    for (const [index, answer] of answers.entries()) {
        const item = findAskUserQuestionItem(questions, answer, index);
        const header = item?.header ?? (answers.length > 1 ? `Question ${index + 1}` : "Answer");
        lines.push(
            `${theme.fg("success", "✓")} ${theme.fg("accent", header)} ${theme.fg("muted", "→")} ${answer.answer}`,
        );
        if (expanded || answers.length === 1) {
            lines.push(theme.fg("dim", answer.question));
        }
    }

    return lines.join("\n");
}

export function createAskUserQuestionRenderer(
    labels: ToolLifecycleLabels,
    labelMode: ToolLabelMode,
): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            if (shouldDeferSimpleToolCall(context)) return emptyComponent();
            return renderThirdPartyCall(theme, {
                state: callState(context),
                statusText: toolStatusLabel(labelMode, context, labels),
                body: summarizeAskUserQuestionArgs(
                    jsonValueParser.parse(args),
                    theme,
                    context.expanded,
                    context,
                ),
                maxRenderedLines: DEFAULT_TOOL_CALL_PREVIEW_LINES,
                expanded: context.expanded,
            });
        },
        renderResult(result, options, theme, context) {
            const summary = summarizeAskUserQuestionResult(
                result,
                jsonValueParser.parse(context.args),
                theme,
                options.expanded,
            );
            if (summary !== undefined && summary.length > 0) {
                return renderGlowupOutput(theme, summary, {
                    expanded: options.expanded,
                    mode: "head",
                    maxPreviewLines: 6,
                    dimContent: false,
                    noOutputLabel: null,
                });
            }
            return renderSimpleResult(theme, result, options);
        },
    };
}
