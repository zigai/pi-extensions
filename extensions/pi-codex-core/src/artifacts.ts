import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

const ARTIFACT_ROOT_DIR = "pi-codex-core";

export function resolveCodexCoreArtifactPath(args: {
    readonly category: string;
    readonly sessionId: string;
    readonly fileName: string;
}): string {
    return join(
        getAgentDir(),
        ARTIFACT_ROOT_DIR,
        sanitizeArtifactPathPart(args.category, "artifacts"),
        sanitizeArtifactPathPart(args.sessionId, "session"),
        args.fileName,
    );
}

export function sanitizeArtifactPathPart(value: string, fallback: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || fallback;
}
