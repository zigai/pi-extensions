import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { compileSchema } from "../schema-parsing.ts";
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
    options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<ImageContent[]> {
    options.signal?.throwIfAborted();
    const imageRefs: RecentImageRef[] = [];
    const branch = ctx.sessionManager.getBranch();
    options.signal?.throwIfAborted();
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
        options.signal?.throwIfAborted();
        if (imageRef.kind === "inline") {
            images.push(imageRef.content);
            continue;
        }
        images.push(
            await prepareCodexPromptImageContent(
                await loadImageContent(imageRef.path, ctx.cwd, options),
                "high",
                options,
            ),
        );
    }
    return images;
}

function extractImageRefsFromEntry(entry: SessionEntry): RecentImageRef[] {
    if (entry.type !== "message") return [];
    const inlineImages = extractInlineImageRefs(entry.message);
    // Current imagegen results attach every generated image inline; saved artifacts
    // are alternate representations (and may be only a subset after save failures).
    // Restored results without attachments use the persisted artifacts instead.
    return inlineImages.length > 0 ? inlineImages : extractImagegenArtifactRefs(entry.message);
}

function extractInlineImageRefs(message: unknown): RecentImageRef[] {
    const parsed = MessageWithArrayContentSchema.decode(message);
    return parsed
        ? parsed.content.flatMap((value): RecentImageRef[] => {
              const content = ImageContentSchema.decode(value);
              return content === undefined ? [] : [{ kind: "inline", content }];
          })
        : [];
}

function extractImagegenArtifactRefs(message: unknown): RecentImageRef[] {
    const parsed = ImagegenArtifactDetailsSchema.decode(message);
    return parsed
        ? parsed.details.images.map(
              (image): RecentImageRef => ({ kind: "artifact", path: image.path }),
          )
        : [];
}
