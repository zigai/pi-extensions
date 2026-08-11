import { chunkGraphemeText, takeGraphemePrefix, takeGraphemeSuffix } from "../glowup/text.ts";
import {
    glowupWireArray,
    glowupWireNumber,
    glowupWireString,
    isGlowupWireRecord,
    parseGlowupWireArgs,
    parseGlowupWireResult,
    type GlowupWireCallContext,
    type GlowupWireRecord,
    type GlowupWireResultContext,
    type GlowupWireToolResult,
} from "../glowup/wire.ts";

const PROMPT_WRAP_GRAPHEMES = 88;
const COLLAPSED_PROMPT_LINES = 5;
const PARTIAL_PROMPT_SCAN_GRAPHEMES = 8 * 1024;
const EXPANDED_PROMPT_GRAPHEMES = 64 * 1024;

type ImagegenGlowupArgs = GlowupWireRecord;
type ImagegenGlowupResult = GlowupWireToolResult;

function nonEmpty(value: string): boolean {
    return value.length > 0;
}

function wrapPromptLine(line: string): string[] {
    const words = line.trim().split(/\s+/u).filter(nonEmpty);
    if (words.length === 0) return [""];

    const lines: string[] = [];
    let current = "";
    for (const word of words) {
        if (current.length === 0 && word.length <= PROMPT_WRAP_GRAPHEMES) {
            current = word;
            continue;
        }
        if (current.length > 0 && current.length + word.length + 1 <= PROMPT_WRAP_GRAPHEMES) {
            current += ` ${word}`;
            continue;
        }
        if (current.length > 0) {
            lines.push(current);
            current = "";
        }
        if (word.length <= PROMPT_WRAP_GRAPHEMES) {
            current = word;
            continue;
        }
        const chunks = chunkGraphemeText(word, PROMPT_WRAP_GRAPHEMES);
        for (const [index, chunk] of chunks.entries()) {
            if (index < chunks.length - 1 || chunk.length >= PROMPT_WRAP_GRAPHEMES) {
                lines.push(chunk);
            } else {
                current = chunk;
            }
        }
    }
    if (current.length > 0) lines.push(current);
    return lines;
}

function wrappedPromptLines(value: string): string[] {
    const lines = value
        .replace(/\r\n/gu, "\n")
        .replace(/\r/gu, "\n")
        .split("\n")
        .flatMap(wrapPromptLine);
    while (lines.length > 0 && lines[0]?.length === 0) lines.shift();
    while (lines.length > 0 && lines.at(-1)?.length === 0) lines.pop();
    return lines;
}

function expandedPromptLines(value: string): string[] {
    const segments = chunkGraphemeText(value, EXPANDED_PROMPT_GRAPHEMES);
    if (segments.length <= 1) return wrappedPromptLines(value);
    const side = Math.floor(EXPANDED_PROMPT_GRAPHEMES / 2);
    return [
        ...wrappedPromptLines(takeGraphemePrefix(value, side)),
        "… prompt truncated at 64 KiB",
        ...wrappedPromptLines(takeGraphemeSuffix(value, side)),
    ];
}

function activePromptLines(value: string): string[] {
    const suffix = takeGraphemeSuffix(value, PARTIAL_PROMPT_SCAN_GRAPHEMES);
    const lines = wrappedPromptLines(suffix);
    if (suffix === value && lines.length <= COLLAPSED_PROMPT_LINES) return lines;
    return ["… earlier prompt", ...lines.slice(-(COLLAPSED_PROMPT_LINES - 1))];
}

function completedPromptLines(value: string): string[] {
    const lines = expandedPromptLines(value);
    if (lines.length <= COLLAPSED_PROMPT_LINES) return lines;
    return [...lines.slice(0, 2), "… prompt omitted", ...lines.slice(-2)];
}

function promptPreview(
    value: string | undefined,
    context: GlowupWireCallContext,
): string | undefined {
    if (value === undefined || value.trim().length === 0) return undefined;
    const lines = context.expanded
        ? expandedPromptLines(value)
        : context.phase === "complete"
          ? completedPromptLines(value)
          : activePromptLines(value);
    return lines.length === 0 ? undefined : lines.join("\n");
}

function summarizeArgs(
    args: ImagegenGlowupArgs,
    context: GlowupWireCallContext,
): string | undefined {
    const prompt = promptPreview(glowupWireString(args, "prompt"), context);
    const referenced =
        glowupWireArray(args, "referenced_image_paths") ?? glowupWireArray(args, "images");
    const recentCount = glowupWireNumber(args, "num_last_images_to_include");
    const metadata = [
        referenced !== undefined && referenced.length > 0 ? `${referenced.length} refs` : undefined,
        recentCount === undefined ? undefined : `${recentCount} recent`,
    ].filter((value): value is string => value !== undefined);
    const summary = [prompt, metadata.join(" • ")]
        .filter((value): value is string => value !== undefined && value.length > 0)
        .join("\n");
    return summary.length === 0 ? undefined : summary;
}

function generatedImageCount(result: ImagegenGlowupResult): number | undefined {
    if (!isGlowupWireRecord(result.details)) return undefined;
    const images = glowupWireArray(result.details, "images");
    if (images !== undefined && images.length > 0) return images.length;
    const generatedCount = glowupWireNumber(result.details, "generatedCount");
    return generatedCount === undefined ? undefined : Math.max(0, Math.trunc(generatedCount));
}

function renderImagegenCall(args: ImagegenGlowupArgs, context: GlowupWireCallContext) {
    const summary = summarizeArgs(args, context);
    return {
        kind: "call" as const,
        labels: {
            static: "Image Generate",
            running: "Generating Image",
            completed: "Generated Image",
        },
        ...(summary === undefined ? {} : { body: { kind: "text" as const, text: summary } }),
        preview: {
            collapsedLines: COLLAPSED_PROMPT_LINES + 1,
            expandedLines: 500,
        },
    };
}

export const imagegenGlowupRendering = {
    version: 3,
    parseArgs: parseGlowupWireArgs,
    parseResult: parseGlowupWireResult,
    renderPartialCall(value: unknown, context: GlowupWireCallContext) {
        const args = parseGlowupWireArgs(value);
        return args === undefined
            ? {
                  kind: "call" as const,
                  labels: { static: "Image Generate", running: "Generating Image" },
              }
            : renderImagegenCall(args, context);
    },
    renderCall(args: ImagegenGlowupArgs, context: GlowupWireCallContext) {
        return renderImagegenCall(args, context);
    },
    renderResult(
        result: ImagegenGlowupResult,
        _context: GlowupWireResultContext<ImagegenGlowupArgs>,
    ) {
        const count = generatedImageCount(result);
        return count === undefined
            ? undefined
            : {
                  kind: "output" as const,
                  text: `Generated ${count} image${count === 1 ? "" : "s"}`,
                  preview: { mode: "head" as const, collapsedLines: 2, expandedLines: 2 },
                  noOutputLabel: null,
              };
    },
} as const;
