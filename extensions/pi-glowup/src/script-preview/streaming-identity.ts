import { parseScriptInvocation, type ScriptInvocation } from "../rendering/core.ts";

/** Keeps the first confidently detected interpreter identity stable for one tool call. */
export class StreamingScriptIdentityStore {
    private readonly identities = new Map<string, Pick<ScriptInvocation, "label" | "language">>();

    constructor(private readonly maxEntries: number = 300) {}

    resolve(toolCallId: string, command: string): ScriptInvocation | undefined {
        const parsed = parseScriptInvocation(command);
        if (parsed === undefined || parsed.label === "Bash") {
            return undefined;
        }
        return this.lock(toolCallId, parsed);
    }

    lock(toolCallId: string, script: ScriptInvocation): ScriptInvocation {
        let identity = this.identities.get(toolCallId);
        if (identity === undefined) {
            identity = { label: script.label, language: script.language };
            this.identities.set(toolCallId, identity);
            this.evictOldest();
        }
        return { ...script, ...identity };
    }

    has(toolCallId: string): boolean {
        return this.identities.has(toolCallId);
    }

    clear(): void {
        this.identities.clear();
    }

    private evictOldest(): void {
        while (this.identities.size > this.maxEntries) {
            const oldest = this.identities.keys().next().value;
            if (typeof oldest !== "string") return;
            this.identities.delete(oldest);
        }
    }
}
