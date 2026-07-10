import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { compileSchema, parseWithSchema } from "../schema-parsing.ts";
import { prepareCodexPromptImageContent } from "./codex-prompt.ts";
import { loadImageContent } from "./file-artifacts.ts";

const ImageContentSchema = compileSchema(
    Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }),
);
const MessageWithArrayContentSchema = compileSchema(
    Type.Object({ content: Type.Array(Type.Unknown()) }),
);
const ImagegenArtifactDetailsSchema = compileSchema(
    Type.Object({
        details: Type.Object({ images: Type.Array(Type.Object({ path: Type.String() })) }),
    }),
);

type RecentImageRef =
    | { readonly kind: "inline"; readonly content: ImageContent }
    | { readonly kind: "artifact"; readonly path: string };

/**
 * Extracts the most recent inline and imagegen artifact images from the active
 * session branch, returning them in chronological order.
 */
export async function recentImageContents(
    ctx: ExtensionContext,
    count: number,
): Promise<ImageContent[]> {
    const imageRefs: RecentImageRef[] = [];
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0 && imageRefs.length < count; index -= 1) {
        const entry = branch[index];
        if (!entry) continue;
        for (const imageRef of extractImageRefsFromEntry(entry).reverse()) {
            imageRefs.push(imageRef);
            if (imageRefs.length >= count) break;
        }
    }

    const images: ImageContent[] = [];
    for (const imageRef of imageRefs.reverse()) {
        if (imageRef.kind === "inline") {
            images.push(imageRef.content);
            continue;
        }
        images.push(
            await prepareCodexPromptImageContent(await loadImageContent(imageRef.path, ctx.cwd)),
        );
    }
    return images;
}

function extractImageRefsFromEntry(entry: SessionEntry): RecentImageRef[] {
    if (entry.type !== "message") return [];
    return [
        ...extractInlineImageRefs(entry.message),
        ...extractImagegenArtifactRefs(entry.message),
    ];
}

function extractInlineImageRefs(message: unknown): RecentImageRef[] {
    const parsed = parseWithSchema(MessageWithArrayContentSchema, message);
    return parsed
        ? parsed.content
              .filter(isImageContent)
              .map((content): RecentImageRef => ({ kind: "inline", content }))
        : [];
}

function extractImagegenArtifactRefs(message: unknown): RecentImageRef[] {
    const parsed = parseWithSchema(ImagegenArtifactDetailsSchema, message);
    return parsed
        ? parsed.details.images.map(
              (image): RecentImageRef => ({ kind: "artifact", path: image.path }),
          )
        : [];
}

function isImageContent(value: unknown): value is ImageContent {
    return parseWithSchema(ImageContentSchema, value) !== undefined;
}
