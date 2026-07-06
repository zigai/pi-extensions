import { describe, expect, it } from "vitest";
import type { ScriptBlockFormatter } from "../src/script-preview/formatters.ts";
import {
    rememberRawScriptPreview,
    scheduleFormattedScriptPreview,
} from "../src/script-preview/events.ts";
import type { ScriptInvocation } from "../src/rendering/core.ts";

class RecordingPreviewSink {
    readonly previews = new Map<string, ScriptInvocation>();

    set(toolCallId: string, preview: ScriptInvocation): void {
        this.previews.set(toolCallId, preview);
    }
}

describe("script preview events", () => {
    it("replaces the preflight preview with the final bash command", () => {
        const sink = new RecordingPreviewSink();

        rememberRawScriptPreview(sink, "call-1", "python - <<'PY'\nprint('preflight')\nPY");
        rememberRawScriptPreview(sink, "call-1", "python - <<'PY'\nprint('actual')\nPY");

        expect(sink.previews.get("call-1")).toEqual({
            label: "Python",
            language: "python",
            code: "print('actual')",
        });
    });

    it("schedules formatter work without waiting for it", async () => {
        const sink = new RecordingPreviewSink();
        let resolveFormatter: ((value: string | undefined) => void) | undefined;
        const formatter: ScriptBlockFormatter = async () =>
            new Promise((resolve) => {
                resolveFormatter = resolve;
            });

        scheduleFormattedScriptPreview({
            sink,
            toolCallId: "call-1",
            command: "python - <<'PY'\nprint(1)\nPY",
            formatter,
        });

        expect(sink.previews.size).toBe(0);
        resolveFormatter?.("print(2)");
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(sink.previews.get("call-1")?.code).toBe("print(2)");
    });
});
