import type { GlowupContentInput, GlowupStreamingPolicy } from "../../tools/protocol/streaming.ts";
import type { ScriptBlockFormatter } from "../../tools/built-in/bash/formatter.ts";
import type { CodeStreamingMode, CodeStreamStore } from "./code-stream.ts";
import { revealProse, type ProseStreamingMode } from "./prose.ts";
import { displayFenceCode, markdownFences } from "./markdown-fences.ts";

export type StreamingPresentationOptions = {
    readonly prose: ProseStreamingMode;
    readonly code: CodeStreamingMode;
    readonly streams: CodeStreamStore;
    readonly formatter?: ScriptBlockFormatter | undefined;
};

function presentMarkdown(
    source: string,
    key: string,
    complete: boolean,
    options: StreamingPresentationOptions,
    targetWidth: number | undefined,
    invalidate: () => void,
): string {
    // Prepare every independent fence once, even while an earlier one is held.
    // Readiness can then be coalesced into one paint without requiring another
    // provider chunk or a component rebuild to start the following block.
    const previews = markdownFences(source).map((fence, index) => {
        const fenceKey = `${key}:fence:${index}`;
        let codeWidth = targetWidth;
        if (codeWidth !== undefined) codeWidth = Math.max(1, codeWidth - fence.widthInset);

        const display = options.streams.get({
            key: fenceKey,
            source: fence.code,
            language: fence.language,
            complete: complete || fence.complete,
            mode: options.code,
            formatter: options.formatter,
            targetWidth: codeWidth,
            invalidate,
        });

        return { fence, fenceKey, display };
    });
    let output = "";
    let offset = 0;
    for (const { fence, fenceKey, display } of previews) {
        const preceding = source.slice(offset, fence.start);
        const code = fence.code;

        // A fence completes ordinary preceding prose, but a trailing heading
        // belongs to its following content, not to an empty pending code block.
        const trailingHeading =
            /(?:^|\n) {0,3}#{1,6}(?:[ \t]+[^\r\n]*)?\r?\n(?:[ \t]*\r?\n)*$/u.test(preceding);
        const emptyCompleteFence = code.trim().length === 0 && (complete || fence.complete);
        if (
            options.prose === "paragraph" &&
            trailingHeading &&
            display.trim().length === 0 &&
            !emptyCompleteFence
        ) {
            return output + revealProse(preceding, options.prose, false);
        }

        output += preceding;

        // Do not display an empty placeholder or later prose ahead of a pending
        // code unit. The store's completion callback will reveal it in order.
        if (display.length === 0 && code.length > 0) return output;

        if (display.length > 0 || fence.complete || complete) {
            output += fence.opener + displayFenceCode(fence, display);
            if (fence.complete) {
                // A ready prefix is not the whole closed block. Keep its real
                // closing fence and following prose behind the remaining units.
                if (options.code !== "token" && !options.streams.ready(fenceKey)) return output;

                if (fence.closed) {
                    if (display.length > 0 && !/[\r\n]$/u.test(display)) output += "\n";
                    output += fence.closer;
                }
            }
        } else if (options.code === "token") {
            output += fence.opener;
        }

        offset = fence.end;
    }

    return output + revealProse(source.slice(offset), options.prose, complete);
}

/** One policy for every generated-content surface; layout and execution remain outside it. */
export function createStreamingPresentation(
    options: () => StreamingPresentationOptions,
): GlowupStreamingPolicy {
    return {
        present(input: GlowupContentInput): string {
            if (input.mode === "immediate") return input.source;

            const current = options();
            if (input.kind === "prose")
                return revealProse(input.source, current.prose, input.complete);

            if (input.kind === "markdown")
                return presentMarkdown(
                    input.source,
                    input.key,
                    input.complete,
                    current,
                    input.targetWidth,
                    input.invalidate ?? (() => {}),
                );

            return current.streams.get({
                ...input,
                mode: current.code,
                formatter: current.formatter,
            });
        },
        settled: async () => options().streams.settled(),
    };
}
