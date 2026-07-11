import { describe, expect, it } from "vitest";
import { StreamingScriptIdentityStore } from "../src/script-preview/streaming-identity.ts";

describe("streaming script identity", () => {
    it("defers generic Bash and locks the first detected interpreter", () => {
        const store = new StreamingScriptIdentityStore();

        expect(store.resolve("call-1", "cd /tmp && no")).toBeUndefined();
        expect(
            store.resolve(
                "call-1",
                "cd /tmp && node --input-type=module <<'EOF'\nimport { value } from './value.js';",
            ),
        ).toEqual({
            label: "Node",
            language: "javascript",
            code: "import { value } from './value.js';",
        });

        expect(
            store.lock("call-1", {
                label: "Bash",
                language: "bash",
                code: "node completed.js",
            }),
        ).toEqual({
            label: "Node",
            language: "javascript",
            code: "node completed.js",
        });
    });

    it("clears identities between sessions", () => {
        const store = new StreamingScriptIdentityStore();
        store.resolve("call-1", "python - <<'PY'\nprint('hi')");
        store.clear();

        expect(store.has("call-1")).toBe(false);
    });
});
