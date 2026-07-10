import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

const REMOTE_COMPACTION_V2_BETA = "remote_compaction_v2";
const CODEX_BETA_FEATURES_HEADER = "x-codex-beta-features";
const CODEX_INSTALLATION_ID_HEADER = "x-codex-installation-id";
const CODEX_TURN_METADATA_HEADER = "x-codex-turn-metadata";
const CODEX_WINDOW_ID_HEADER = "x-codex-window-id";

export type RemoteCompactionTransportMetadata = {
    readonly sessionId: string;
    readonly turnId: string;
    readonly windowId: string;
    readonly turnMetadata: string;
    readonly clientMetadata: Readonly<Record<string, string>>;
};

/** Builds the Codex request identity required by the remote compaction v2 contract. */
export function buildRemoteCompactionTransportMetadata(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly windowId: string;
    readonly reason: SessionBeforeCompactEvent["reason"];
    readonly startedAtMs: number;
}): RemoteCompactionTransportMetadata {
    const sessionId = safeHeaderIdentity(input.sessionId, "pi-session");
    const turnId = safeHeaderIdentity(input.turnId, sessionId);
    const windowId = safeHeaderIdentity(input.windowId, `pi-window-${sessionId}`);
    const turnMetadata = JSON.stringify({
        installation_id: sessionId,
        session_id: sessionId,
        thread_id: sessionId,
        turn_id: turnId,
        window_id: windowId,
        request_kind: "compaction",
        compaction: {
            trigger: input.reason === "manual" ? "manual" : "auto",
            reason: input.reason === "manual" ? "user_requested" : "context_limit",
            implementation: "responses_compaction_v2",
            phase: "standalone_turn",
            strategy: "memento",
        },
        turn_started_at_unix_ms: input.startedAtMs,
    });
    return {
        sessionId,
        turnId,
        windowId,
        turnMetadata,
        clientMetadata: {
            [CODEX_INSTALLATION_ID_HEADER]: sessionId,
            session_id: sessionId,
            thread_id: sessionId,
            turn_id: turnId,
            [CODEX_WINDOW_ID_HEADER]: windowId,
            [CODEX_TURN_METADATA_HEADER]: turnMetadata,
        },
    };
}

/** Applies HTTP projections of the remote compaction v2 request metadata. */
export function applyRemoteCompactionTransportHeaders(
    headers: Headers,
    metadata: RemoteCompactionTransportMetadata,
): void {
    headers.set(
        CODEX_BETA_FEATURES_HEADER,
        appendHeaderListValue(headers.get(CODEX_BETA_FEATURES_HEADER), REMOTE_COMPACTION_V2_BETA),
    );
    headers.set(CODEX_INSTALLATION_ID_HEADER, metadata.sessionId);
    headers.set(CODEX_WINDOW_ID_HEADER, metadata.windowId);
    headers.set(CODEX_TURN_METADATA_HEADER, metadata.turnMetadata);
    headers.set("x-client-request-id", metadata.sessionId);
    headers.set("session-id", metadata.sessionId);
    headers.set("thread-id", metadata.sessionId);
}

function appendHeaderListValue(current: string | null, value: string): string {
    const values = (current ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    if (!values.includes(value)) values.push(value);
    return values.join(",");
}

function safeHeaderIdentity(value: string, fallback: string): string {
    const normalized = Array.from(value.trim())
        .slice(0, 128)
        .join("")
        .replaceAll(/[^\x21-\x7e]/g, "_");
    return normalized.length > 0 ? normalized : fallback;
}
