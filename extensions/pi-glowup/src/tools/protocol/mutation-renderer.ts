import type { Component } from "@earendil-works/pi-tui";

import { buildPierreDiffPayloadsFromPatch } from "../../rendering/diff/payload.ts";
import {
    renderPierreDiff,
    type PierreDiffRenderContext,
} from "../../rendering/diff/pierre-renderer.ts";
import type { PierreDiffPayload } from "../../rendering/diff/types.ts";
import {
    PREVIEW_MUTATION_SETTINGS,
    showsFullMutation,
    type MutationSettings,
} from "../../rendering/preview-settings.ts";
import { makeComponent } from "../../rendering/component.ts";
import {
    renderGlowupDiff,
    type GlowupDiffRenderOptions,
} from "../../rendering/diff/text-renderer.ts";
import { renderMutationCall } from "../../rendering/tool-header.ts";
import { type DiffLineCoordinates, type DiffSection } from "../../rendering/diff/text-diff.ts";
import { type GlowupCallState, type GlowupRenderTheme } from "../../rendering/theme.ts";
import type { GlowupMutationFile, GlowupMutationLine, GlowupMutationNode } from "./contract.ts";
import type { ThirdPartyToolRenderContext } from "../types.ts";

function normalizedPatchPath(path: string): string {
    return path
        .replaceAll("\\", "/")
        .replace(/^\.\//u, "")
        .replace(/^(?:a|b)\//u, "")
        .replace(/\/{2,}/gu, "/");
}

function mutationPath(file: GlowupMutationFile): string {
    if (
        file.previousPath === undefined ||
        normalizedPatchPath(file.previousPath) === normalizedPatchPath(file.path)
    ) {
        return file.path;
    }
    return `${file.previousPath} → ${file.path}`;
}

function numberedDiffLine(line: GlowupMutationLine): string {
    switch (line.kind) {
        case "addition":
            return line.newLine === undefined ? `+ ${line.text}` : `+${line.newLine} ${line.text}`;
        case "deletion":
            return line.oldLine === undefined ? `- ${line.text}` : `-${line.oldLine} ${line.text}`;
        case "context": {
            const lineNumber = line.newLine ?? line.oldLine;
            return lineNumber === undefined ? `  ${line.text}` : ` ${lineNumber} ${line.text}`;
        }
        case "metadata":
            return `    ${line.text}`;
        case "omission":
            return `    …${line.text.length === 0 ? "" : ` ${line.text}`}`;
    }
}

function lineCoordinates(line: GlowupMutationLine): DiffLineCoordinates | undefined {
    if (line.oldLine === undefined && line.newLine === undefined) return undefined;
    let coordinates: DiffLineCoordinates = {};
    if (line.oldLine !== undefined) {
        coordinates = { ...coordinates, oldLine: line.oldLine };
    }
    if (line.newLine !== undefined) {
        coordinates = { ...coordinates, newLine: line.newLine };
    }
    return coordinates;
}

function diffSection(file: GlowupMutationFile): DiffSection {
    return {
        path: mutationPath(file),
        lines: file.lines.map(numberedDiffLine),
        lineCoordinates: file.lines.map(lineCoordinates),
        added: file.added,
        removed: file.removed,
    };
}

function payloadPaths(payload: PierreDiffPayload): readonly string[] {
    const paths =
        payload.kind === "renderable"
            ? [payload.metadata.name, payload.metadata.prevName].filter(
                  (path): path is string => path !== undefined,
              )
            : payload.path.split(" → ");
    return paths.flatMap((path) => path.split(" → ").map(normalizedPatchPath));
}

function payloadsByPath(payloads: readonly PierreDiffPayload[]): Map<string, PierreDiffPayload[]> {
    const byPath = new Map<string, PierreDiffPayload[]>();
    for (const payload of payloads) {
        for (const path of new Set(payloadPaths(payload))) {
            const queue = byPath.get(path) ?? [];
            queue.push(payload);
            byPath.set(path, queue);
        }
    }
    return byPath;
}

function consumePayload(
    byPath: Map<string, PierreDiffPayload[]>,
    consumed: Set<PierreDiffPayload>,
    file: GlowupMutationFile,
): PierreDiffPayload | undefined {
    const paths = [file.path, file.previousPath]
        .filter((path): path is string => path !== undefined)
        .map(normalizedPatchPath);
    for (const path of paths) {
        const queue = byPath.get(path);
        while (queue !== undefined && queue.length > 0) {
            const payload = queue.shift();
            if (payload !== undefined && !consumed.has(payload)) {
                consumed.add(payload);
                return payload;
            }
        }
    }
    return undefined;
}

function mutationPayloads(
    node: GlowupMutationNode,
    settings: MutationSettings,
): ReadonlyArray<PierreDiffPayload | undefined> {
    if (node.patch === undefined) return node.files.map(() => undefined);
    const payloads = buildPierreDiffPayloadsFromPatch(node.patch, {
        maxBytes: settings.limits.maxDiffBytes,
        maxLines: settings.limits.maxDiffLines,
    });
    const byPath = payloadsByPath(payloads);
    const consumed = new Set<PierreDiffPayload>();
    return node.files.map((file) => consumePayload(byPath, consumed, file));
}

type ProtocolMutationUpdate = {
    readonly node: GlowupMutationNode;
    readonly theme: GlowupRenderTheme;
    readonly context: ThirdPartyToolRenderContext;
    readonly label: string;
    readonly state: GlowupCallState;
    readonly mutationSettings: MutationSettings;
};

class ProtocolMutationComponent implements Component {
    private diffComponents = new Map<string, Component>();
    private rendered: Component;

    constructor(
        private readonly toolCallId: string,
        update: ProtocolMutationUpdate,
    ) {
        this.rendered = this.build(update);
    }

    belongsTo(toolCallId: string): boolean {
        return this.toolCallId === toolCallId;
    }

    update(update: ProtocolMutationUpdate): void {
        this.rendered = this.build(update);
    }

    render(width: number): string[] {
        return this.rendered.render(width);
    }

    invalidate(): void {
        this.rendered.invalidate();
    }

    private build(update: ProtocolMutationUpdate): Component {
        const payloads = mutationPayloads(update.node, update.mutationSettings);
        const pathOccurrences = new Map<string, number>();
        const nextDiffComponents = new Map<string, Component>();
        const sections = update.node.files.map((file, index) => {
            const path = mutationPath(file);
            const occurrence = pathOccurrences.get(path) ?? 0;
            pathOccurrences.set(path, occurrence + 1);
            const componentKey = `${path}\u0000${occurrence}`;
            const previousDiff = this.diffComponents.get(componentKey);
            const payload = payloads[index];
            const expanded = showsFullMutation(update.mutationSettings, update.context.expanded);
            let diffOptions: GlowupDiffRenderOptions = {
                collapsedLineBudget: update.mutationSettings.previewLines,
            };
            if (!update.context.expanded) {
                diffOptions = { ...diffOptions, maxWrappedRows: 4 };
            }
            let pierreContext: PierreDiffRenderContext = {
                lastComponent: previousDiff,
                toolCallId: `${this.toolCallId}:${componentKey}`,
            };
            if (update.context.invalidate !== undefined) {
                pierreContext = { ...pierreContext, invalidate: update.context.invalidate };
            }
            const diff =
                payload === undefined
                    ? renderGlowupDiff(update.theme, [diffSection(file)], expanded, diffOptions)
                    : renderPierreDiff(
                          payload,
                          update.theme,
                          {
                              expanded: update.context.expanded,
                              mutationSettings: update.mutationSettings,
                              expandedRows: "full",
                          },
                          pierreContext,
                      );
            nextDiffComponents.set(componentKey, diff);
            const showStats = update.state !== "running" && file.countsKnown !== false;
            const header = renderMutationCall(
                update.theme,
                {
                    label: update.label,
                    path,
                    added: showStats ? file.added : 0,
                    removed: showStats ? file.removed : 0,
                },
                { state: update.state },
            );
            return makeComponent((width) => [
                ...header.render(width),
                ...(file.lines.length === 0 && payload === undefined ? [] : diff.render(width)),
            ]);
        });
        this.diffComponents = nextDiffComponents;
        return makeComponent((width) =>
            sections.flatMap((section, index) => [
                ...(index === 0 ? [] : [""]),
                ...section.render(width),
            ]),
        );
    }
}

export type ProtocolMutationRenderOptions = {
    readonly label: string;
    readonly state: GlowupCallState;
    readonly mutationSettings?: MutationSettings;
};

/** Renders a decoded mutation node through Glowup's configured mutation engine. */
export function renderProtocolMutation(
    node: GlowupMutationNode,
    theme: GlowupRenderTheme,
    context: ThirdPartyToolRenderContext,
    options: ProtocolMutationRenderOptions,
): Component {
    const update: ProtocolMutationUpdate = {
        node,
        theme,
        context,
        label: options.label,
        state: options.state,
        mutationSettings: options.mutationSettings ?? PREVIEW_MUTATION_SETTINGS,
    };
    if (
        context.lastComponent instanceof ProtocolMutationComponent &&
        context.lastComponent.belongsTo(context.toolCallId)
    ) {
        context.lastComponent.update(update);
        return context.lastComponent;
    }
    return new ProtocolMutationComponent(context.toolCallId, update);
}
