import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ActivePromptFragment } from "./resolve-capability-policy.ts";

const MAX_FRAGMENT_BYTES = 50_000;
const MAX_COMBINED_FRAGMENT_BYTES = 100_000;

export type PromptFragmentLoadContext = {
    readonly cwd: string;
    readonly projectTrusted: boolean;
    readonly globalConfigPath: string;
    readonly projectConfigPath?: string;
};

export type PromptFragmentLoadResult = {
    readonly prompt: string;
    readonly diagnostics: readonly string[];
};

function isWithin(root: string, candidate: string): boolean {
    const path = relative(root, candidate);
    return path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

async function loadFragment(
    scoped: ActivePromptFragment,
    context: PromptFragmentLoadContext,
): Promise<{ readonly content?: string; readonly diagnostic?: string }> {
    const content = scoped.fragment.content;
    if (content.kind === "inline") {
        return Buffer.byteLength(content.text) <= MAX_FRAGMENT_BYTES
            ? { content: content.text }
            : {
                  diagnostic: `Ignored ${scoped.fragment.id}: prompt fragments are limited to 50KB.`,
              };
    }
    if (scoped.scope === "project" && !context.projectTrusted) {
        return { diagnostic: `Ignored untrusted project prompt fragment ${content.path}.` };
    }
    const configPath =
        scoped.scope === "global" ? context.globalConfigPath : context.projectConfigPath;
    if (configPath === undefined) {
        return {
            diagnostic: `No project settings path is available for prompt fragment ${content.path}.`,
        };
    }
    const path = isAbsolute(content.path)
        ? content.path
        : resolve(dirname(configPath), content.path);
    if (scoped.scope === "project" && !isWithin(context.cwd, path)) {
        return {
            diagnostic: `Project prompt fragment escapes the trusted project: ${content.path}.`,
        };
    }
    try {
        let readablePath = path;
        if (scoped.scope === "project") {
            const [projectRoot, canonicalPath] = await Promise.all([
                realpath(context.cwd),
                realpath(path),
            ]);
            if (!isWithin(projectRoot, canonicalPath)) {
                return {
                    diagnostic: `Project prompt fragment escapes the trusted project through a symbolic link: ${content.path}.`,
                };
            }
            readablePath = canonicalPath;
        }
        const text = await readFile(readablePath, "utf8");
        return Buffer.byteLength(text) <= MAX_FRAGMENT_BYTES
            ? { content: text }
            : { diagnostic: `Ignored ${content.path}: prompt fragments are limited to 50KB.` };
    } catch (cause: unknown) {
        return {
            diagnostic: `Could not read prompt fragment ${content.path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
    }
}

export async function appendActivePromptFragments(
    basePrompt: string,
    fragments: readonly ActivePromptFragment[],
    context: PromptFragmentLoadContext,
): Promise<PromptFragmentLoadResult> {
    const sections: string[] = [];
    const diagnostics: string[] = [];
    let totalBytes = 0;
    for (const scoped of fragments) {
        const loaded = await loadFragment(scoped, context);
        if (loaded.diagnostic !== undefined) {
            diagnostics.push(loaded.diagnostic);
        }
        if (loaded.content === undefined) {
            continue;
        }
        const section = `## Pi Toggles: ${scoped.fragment.id}\n\n${loaded.content}`;
        const bytes = Buffer.byteLength(section);
        if (totalBytes + bytes > MAX_COMBINED_FRAGMENT_BYTES) {
            diagnostics.push("Active system-prompt fragments exceeded the combined 100KB limit.");
            break;
        }
        totalBytes += bytes;
        sections.push(section);
    }
    return {
        prompt: sections.length === 0 ? basePrompt : `${basePrompt}\n\n${sections.join("\n\n")}`,
        diagnostics,
    };
}
