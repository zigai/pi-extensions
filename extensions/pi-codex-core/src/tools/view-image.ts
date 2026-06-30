import { readFileSync } from "node:fs";

import { Type } from "typebox";

import { compileSchema, parseWithSchema } from "../schema-parsing.ts";
import { StringEnum, type ImageContent } from "@earendil-works/pi-ai";
import {
    Container,
    getCapabilities,
    getImageDimensions,
    Image,
    imageFallback,
    Spacer,
    Text,
} from "@earendil-works/pi-tui";
import type {
    ExtensionAPI,
    ExtensionContext,
    ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { resolveCodexRequestModel, type CodexCoreConfig } from "../config.ts";
import {
    codexToolProviderHeaders,
    resolveCodexResponsesUrl,
    resolveCodexToolProvider,
} from "../codex-auth.ts";
import {
    imageContentToDataUrl,
    loadImageContent,
    modelSupportsImages,
    prepareCodexPromptImageContent,
    type ImageDetail,
    type LoadedImage,
} from "../image-content.ts";

const IMAGE_DESCRIPTION_PROMPT =
    "Describe this image in detail. Output only the image description, no other commentary.";

const ImageContentBlockSchema = compileSchema(
    Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }),
);
const TextContentBlockSchema = compileSchema(
    Type.Object({ type: Type.Literal("text"), text: Type.String() }),
);
const ViewImageArgumentsSchema = compileSchema(
    Type.Object({
        path: Type.Optional(Type.String()),
        file_path: Type.Optional(Type.String()),
        image_path: Type.Optional(Type.String()),
        detail: Type.Optional(StringEnum(["auto", "high", "original"] as const)),
    }),
);
const DescriptionResponseSchema = compileSchema(
    Type.Object({
        output_text: Type.Optional(Type.String()),
        output: Type.Optional(
            Type.Array(
                Type.Object({
                    content: Type.Optional(
                        Type.Array(Type.Object({ text: Type.Optional(Type.String()) })),
                    ),
                }),
            ),
        ),
    }),
);

const VIEW_IMAGE_PARAMETERS = Type.Object({
    path: Type.String({ description: "Path to a local image file." }),
    detail: Type.Optional(
        StringEnum(["auto", "high", "original"] as const, { description: "Image detail level." }),
    ),
});

type ViewImageParams = {
    readonly path: string;
    readonly detail?: "auto" | "high" | "original";
};

type ViewImageDetails = {
    readonly path: string;
    readonly absolutePath: string;
    readonly described: boolean;
    readonly mimeType?: string | undefined;
};

type ViewImageRenderState = {
    preview?: ImageContent | null;
};

type ViewImageToolOptions = {
    readonly getConfig: () => CodexCoreConfig;
};

export const VIEW_IMAGE_TOOL_NAME = "view_image";

export function registerViewImageTool(pi: ExtensionAPI, options: ViewImageToolOptions): void {
    pi.registerTool(createViewImageTool(options));
}

export function createViewImageTool(
    options: ViewImageToolOptions,
): ToolDefinition<typeof VIEW_IMAGE_PARAMETERS, ViewImageDetails, ViewImageRenderState> {
    return {
        name: VIEW_IMAGE_TOOL_NAME,
        label: "View Image",
        description:
            "View a local image file and return it to the model, or describe it through Codex for text-only models when enabled.",
        promptSnippet: "View a local image file by path.",
        promptGuidelines: [
            "Use view_image when the user asks to inspect a local image file; pass the path exactly and do not use it for text files.",
            "Use read for text files and as a fallback for image files when view_image is unavailable.",
        ],
        parameters: VIEW_IMAGE_PARAMETERS,
        prepareArguments: prepareViewImageArguments,
        renderCall(args, theme, _context) {
            const parts = [args.path || "..."];
            if (args.detail) parts.push(`detail=${args.detail}`);
            const text =
                theme.fg("toolTitle", theme.bold("view_image ")) +
                theme.fg(args.path ? "accent" : "dim", parts.join(" • "));
            return new Text(text, 0, 0);
        },
        renderResult(result, { expanded, isPartial }, theme, context) {
            if (isPartial) return new Text(theme.fg("warning", "Loading image..."), 0, 0);
            const path = result.details.path || context.args.path || "image";
            const inlineImage = firstImageContent(result.content);
            const previewImage = inlineImage
                ? undefined
                : loadPreviewImage(result.details, context.state);
            const displayedImage = inlineImage ?? previewImage;
            const capabilities = getCapabilities();
            const lines: string[] = [];
            if (displayedImage && (!capabilities.images || !context.showImages)) {
                const dimensions =
                    getImageDimensions(displayedImage.data, displayedImage.mimeType) ?? undefined;
                lines.push(
                    theme.fg(
                        "toolOutput",
                        imageFallback(displayedImage.mimeType, dimensions, path),
                    ),
                );
            }
            const description = firstTextContent(result.content);
            if (description) {
                lines.push(
                    theme.fg("toolOutput", expanded ? description : compactText(description, 180)),
                );
            }
            if (!displayedImage || !capabilities.images || !context.showImages) {
                if (lines.length === 0) return new Container();
                return new Text(lines.join("\n"), 0, 0);
            }
            const container = new Container();
            if (lines.length > 0) {
                container.addChild(new Text(lines.join("\n"), 0, 0));
                container.addChild(new Spacer(1));
            }
            container.addChild(
                new Image(
                    displayedImage.data,
                    displayedImage.mimeType,
                    { fallbackColor: (value: string) => theme.fg("toolOutput", value) },
                    { maxWidthCells: 60, filename: path },
                ),
            );
            return container;
        },
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const image = await loadImageContent(params.path, ctx.cwd);
            const detail = params.detail ?? "high";
            if (modelSupportsImages(ctx.model)) {
                const content = await prepareCodexPromptImageContent(image, detail);
                return {
                    content: [content],
                    details: {
                        path: params.path,
                        absolutePath: image.absolutePath,
                        described: false,
                        mimeType: content.mimeType,
                    },
                };
            }

            const config = options.getConfig();
            if (!config.tools.viewImageDescriptions) {
                throw new Error(
                    "view_image requires an image-capable model, or enable /codex image descriptions.",
                );
            }

            const description = await describeImage(image, detail, ctx, config, signal);
            return {
                content: [{ type: "text", text: description }],
                details: {
                    path: params.path,
                    absolutePath: image.absolutePath,
                    described: true,
                    mimeType: image.content.mimeType,
                },
            };
        },
    };
}

export function prepareViewImageArguments(args: unknown): ViewImageParams {
    const input = parseWithSchema(ViewImageArgumentsSchema, args);
    if (!input) return { path: "" };
    const path = input.path ?? input.file_path ?? input.image_path ?? "";
    return input.detail ? { path, detail: input.detail } : { path };
}

type TextContentBlock = {
    readonly type: "text";
    readonly text: string;
};

function firstImageContent(content: readonly unknown[]): ImageContent | undefined {
    return content.find(isImageContentBlock);
}

function firstTextContent(content: readonly unknown[]): string | undefined {
    for (const item of content) {
        if (isTextContentBlock(item)) {
            const text = item.text.trim();
            if (text.length > 0) return text;
        }
    }
    return undefined;
}

function isImageContentBlock(value: unknown): value is ImageContent {
    return parseWithSchema(ImageContentBlockSchema, value) !== undefined;
}

function isTextContentBlock(value: unknown): value is TextContentBlock {
    return parseWithSchema(TextContentBlockSchema, value) !== undefined;
}

function loadPreviewImage(
    details: ViewImageDetails,
    state: ViewImageRenderState,
): ImageContent | undefined {
    if (state.preview !== undefined) return state.preview ?? undefined;
    if (!details.mimeType) {
        state.preview = null;
        return undefined;
    }
    try {
        state.preview = {
            type: "image",
            data: readFileSync(details.absolutePath).toString("base64"),
            mimeType: details.mimeType,
        };
        return state.preview;
    } catch {
        state.preview = null;
        return undefined;
    }
}

function compactText(value: string, maxCharacters: number): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    const limit = Math.max(4, maxCharacters);
    return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

async function describeImage(
    image: LoadedImage,
    detail: ImageDetail,
    ctx: ExtensionContext,
    config: CodexCoreConfig,
    signal: AbortSignal | undefined,
): Promise<string> {
    const promptImage = await prepareCodexPromptImageContent(image, detail);
    const provider = await resolveCodexToolProvider(ctx);
    const headers = codexToolProviderHeaders(provider);
    headers.set("OpenAI-Beta", "responses=experimental");
    headers.set("accept", "application/json");

    const model = resolveCodexRequestModel(config.openai.imageDescriptionModel, provider.model);

    const response = await fetch(resolveCodexResponsesUrl(provider.baseUrl), {
        method: "POST",
        headers,
        ...(signal ? { signal } : {}),
        body: JSON.stringify({
            model,
            store: false,
            stream: false,
            instructions: IMAGE_DESCRIPTION_PROMPT,
            text: { verbosity: "low" },
            reasoning: { effort: "low", summary: "auto" },
            input: [
                {
                    role: "user",
                    content: [
                        { type: "input_text", text: "Describe the image." },
                        {
                            type: "input_image",
                            image_url: imageContentToDataUrl(promptImage),
                            detail: detail === "original" ? "high" : detail,
                        },
                    ],
                },
            ],
        }),
    });

    const responseText = await response.text();
    if (!response.ok)
        throw new Error(
            `view_image description failed (${response.status}): ${responseText || response.statusText}`,
        );
    const rawDescriptionPayload: unknown = JSON.parse(responseText);
    const description = extractOutputText(rawDescriptionPayload);
    if (!description) throw new Error("view_image description returned no text");
    return description;
}

function extractOutputText(value: unknown): string | undefined {
    const response = parseWithSchema(DescriptionResponseSchema, value);
    if (!response) return undefined;
    if (response.output_text && response.output_text.trim().length > 0)
        return response.output_text.trim();
    const parts: string[] = [];
    for (const item of response.output ?? []) {
        for (const content of item.content ?? []) {
            if (content.text) parts.push(content.text);
        }
    }
    const text = parts.join("").trim();
    return text.length > 0 ? text : undefined;
}
