import { createHash } from "node:crypto";
import { decodeGlowupNode } from "../../src/tools/protocol/decode.ts";
import { renderProtocolNode } from "../../src/tools/protocol/node-renderer.ts";
import {
    call,
    code,
    empty,
    list,
    mutation,
    output,
    stack,
    summary,
    text,
    type GlowupNode,
    type GlowupTone,
} from "../../src/tools/protocol/nodes.ts";
import type { GlowupRenderTheme } from "../../src/rendering/theme.ts";

const labels = { static: "Patch", running: "Patching", completed: "Patched", failed: "Failed" };

const tones: readonly GlowupTone[] = [
    "default",
    "muted",
    "dim",
    "accent",
    "success",
    "error",
    "path",
    "url",
    "code",
];

const source = "const 界 = '👩‍💻';\r\n\t// é\n\u001b[31mcolored\u001b[0m\n\u001b[2Junsafe\n";

export function protocolDecodingNodes(): GlowupNode[] {
    const nodes: GlowupNode[] = [
        empty(),
        text(""),
        text(source),
        ...tones.map((tone) => text({ kind: "text", text: source, tone, bold: true })),
        summary([{ label: "Path", value: { kind: "text", text: "AGENTS.md", tone: "path" } }]),
        output(undefined),
        output("", { noOutputLabel: null }),
        output(source, { syntax: { language: "text", path: "file.txt" }, noOutputLabel: "Empty" }),
        mutation(labels, [
            {
                path: "new.ts",
                previousPath: "old.ts",
                added: 2,
                removed: 1,
                countsKnown: false,
                lines: [
                    { kind: "metadata", text: "@@ -1,2 +1,3 @@" },
                    { kind: "context", text: "const unchanged = 0;", oldLine: 1, newLine: 1 },
                    { kind: "deletion", text: "const before = 1;", oldLine: 2 },
                    { kind: "addition", text: "const after = 2;", newLine: 2 },
                    { kind: "addition", text: "// 界 👩‍💻", newLine: 3 },
                    { kind: "omission", text: "…" },
                ],
            },
        ]),
    ];
    for (const mode of ["head", "headTail", "hidden"] as const) {
        const preview = { mode, collapsedLines: 2.9, expandedLines: 4.8, expandable: true };

        nodes.push(
            code(source.repeat(3), {
                title: { kind: "text", text: "Code", bold: false },
                syntax: { language: "text", path: "code.txt" },
                preview,
            }),
            list(
                ["first", { kind: "text", text: "styled", tone: "success" }, text("last")],
                preview,
            ),
            call(labels, { body: stack([text("before"), output(source), empty()]), preview }),
        );
    }

    return [...nodes, stack(nodes)];
}

const theme: GlowupRenderTheme = {
    fg(token, value) {
        const color = 30 + (token.length % 8);
        return `\u001b[${color}m${value}\u001b[39m`;
    },
    bg(_token, value) {
        return `\u001b[42m${value}\u001b[49m`;
    },
    bold(value) {
        return `\u001b[1m${value}\u001b[22m`;
    },
};

export function protocolDecodingGolden(): string {
    const snapshots: Record<string, string> = {};
    const nodes = protocolDecodingNodes();
    for (const [index, input] of nodes.entries()) {
        const decoded = decodeGlowupNode(input);
        if (decoded === undefined) throw new Error(`Corpus node ${index} rejected`);

        const frames: string[][] = [];
        for (const expanded of [false, true]) {
            for (const isPartial of [false, true]) {
                const component = renderProtocolNode(
                    decoded,
                    theme,
                    {
                        args: {},
                        toolCallId: `golden-${index}`,
                        executionStarted: true,
                        argsComplete: !isPartial,
                        isPartial,
                        expanded,
                        showImages: false,
                        isError: false,
                    },
                    "lifecycle",
                );
                for (const width of [20, 80, 180, 80]) frames.push(component.render(width));
            }
        }

        snapshots[`node-${index}`] = createHash("sha256")
            .update(JSON.stringify({ decoded, frames }))
            .digest("hex");
    }

    const boundaryValues = [
        undefined,
        null,
        false,
        true,
        "",
        0,
        1,
        -1,
        1.5,
        NaN,
        Infinity,
        -Infinity,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER + 1,
        [],
        {},
        "invalid",
    ];

    const decodedVariants = [];
    for (const node of nodes) {
        for (const key of Object.keys(node)) {
            for (const value of boundaryValues)
                decodedVariants.push(decodeGlowupNode({ ...node, [key]: value }));
        }
    }

    const mutationFile = {
        path: "file.txt",
        previousPath: "old.txt",
        lines: [],
        added: 0,
        removed: 0,
        countsKnown: true,
    };
    for (const value of boundaryValues) {
        for (const key of ["kind", "text", "tone", "bold"]) {
            decodedVariants.push(
                decodeGlowupNode({
                    kind: "text",
                    text: {
                        kind: "text",
                        text: source,
                        tone: "accent",
                        bold: true,
                        [key]: value,
                    },
                }),
            );
        }

        for (const key of Object.keys(labels)) {
            decodedVariants.push(
                decodeGlowupNode({ kind: "call", labels: { ...labels, [key]: value } }),
            );
        }

        for (const key of ["language", "path"]) {
            decodedVariants.push(
                decodeGlowupNode({
                    kind: "code",
                    text: source,
                    syntax: { language: "text", path: "file.txt", [key]: value },
                }),
            );
        }

        for (const key of Object.keys(mutationFile)) {
            decodedVariants.push(
                decodeGlowupNode({
                    kind: "mutation",
                    labels,
                    files: [{ ...mutationFile, [key]: value }],
                }),
            );
        }

        for (const key of ["mode", "collapsedLines", "expandedLines", "expandable"]) {
            decodedVariants.push(
                decodeGlowupNode({ kind: "code", text: source, preview: { [key]: value } }),
            );
        }
    }

    snapshots["malformed-and-optional-fields"] = createHash("sha256")
        .update(JSON.stringify(decodedVariants))
        .digest("hex");

    return `${JSON.stringify(snapshots, null, 2)}\n`;
}
