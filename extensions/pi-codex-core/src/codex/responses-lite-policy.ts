/** Coordinates Responses Lite headers with Pi compaction requests that bypass payload hooks. */
export class ResponsesLiteRequestPolicy {
    readonly #piFallbackSessions = new Set<string>();
    readonly #suppressedHeaderSessions = new Set<string>();

    beginPiCompactionFallback(sessionId: string): void {
        this.#piFallbackSessions.add(sessionId);
    }

    shouldAttachLiteHeader(sessionId: string): boolean {
        if (!this.#piFallbackSessions.has(sessionId)) {
            this.#suppressedHeaderSessions.delete(sessionId);
            return true;
        }
        this.#suppressedHeaderSessions.add(sessionId);
        return false;
    }

    shouldRewriteLitePayload(sessionId: string): boolean {
        if (!this.#suppressedHeaderSessions.delete(sessionId)) return true;
        this.#piFallbackSessions.delete(sessionId);
        return false;
    }

    finishCompaction(sessionId: string): void {
        this.clearSession(sessionId);
    }

    clearSession(sessionId: string): void {
        this.#piFallbackSessions.delete(sessionId);
        this.#suppressedHeaderSessions.delete(sessionId);
    }
}
