import { describe, expect, it } from "vitest";
import { StreamingScriptIdentityStore } from "../../../../src/tools/built-in/bash/streaming-identity.ts";

describe("streaming script identity", () => {
    it("defers generic Bash and locks the first detected interpreter", () => {
        const store = new StreamingScriptIdentityStore();

        expect(store.resolve("call-1", "cd /tmp && no")).toBeUndefined();
        expect(
            store.resolve(
                "call-1",
                "cd /tmp && node --input-type=module <<'EOF'\nimport { value } from './value.js';",
            ),
        ).toBeUndefined();

        expect(
            store.resolve(
                "call-1",
                "node --input-type=module <<'EOF'\nimport { value } from './value.js';",
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

    it("lets the completed command replace a speculative streaming identity", () => {
        const store = new StreamingScriptIdentityStore();
        store.resolve("call-1", `python -c "print('partial')"`);

        expect(store.finalize("call-1", undefined)).toBeUndefined();
        expect(store.has("call-1")).toBe(false);

        const node = {
            label: "Node",
            language: "javascript",
            code: "console.log('complete')",
        };
        store.resolve("call-2", `python -c "print('partial')"`);
        expect(store.finalize("call-2", node)).toEqual(node);
        expect(
            store.lock("call-2", {
                label: "Python",
                language: "python",
                code: "print('later partial')",
            }),
        ).toEqual({ ...node, code: "print('later partial')" });
    });
});
