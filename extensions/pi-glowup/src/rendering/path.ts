import { type GlowupRenderTheme, instructionPathText, muted, pathText } from "./theme.ts";

export function collapseHome(path: string): string {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (
        home !== undefined &&
        home.length > 0 &&
        (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`))
    ) {
        return `~${path.slice(home.length)}`;
    }
    return path;
}

export function isInstructionFilePath(path: string | undefined): boolean {
    const normalized = (path ?? "").replace(/\\/g, "/");
    const segments = normalized.split("/").filter((segment) => segment.length > 0);
    if (segments[segments.length - 1] === "AGENTS.md") {
        return true;
    }

    return /(?:^|\/|~\/)\.pi\/agent\/(?:skills\/[^/]+\/|(?:git|npm\/node_modules)\/.+\/skills\/[^/]+\/)/u.test(
        normalized,
    );
}

export function isPartialInstructionFilePath(path: string | undefined): boolean {
    const normalized = (path ?? "").replace(/\\/g, "/");
    const basename = normalized.split("/").at(-1) ?? "";
    if (basename === "AGENTS" || basename.startsWith("AGENTS.")) {
        return true;
    }

    return /(?:^|\/|~\/)\.pi\/agent\/(?:skills(?:\/|$)|(?:git|npm\/node_modules)\/.+\/skills(?:\/|$))/u.test(
        normalized,
    );
}

export function formatPathTarget(
    theme: GlowupRenderTheme,
    path: string | undefined,
    options: { readonly isPartial?: boolean } = {},
): string {
    const displayPath = collapseHome(path ?? "");
    if (
        isInstructionFilePath(path) ||
        (options.isPartial === true && isPartialInstructionFilePath(path))
    ) {
        return instructionPathText(theme, displayPath);
    }
    if (options.isPartial === true) {
        return muted(theme, displayPath);
    }
    return pathText(theme, displayPath);
}
