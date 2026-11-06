import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createFooterComponent } from "../src/footer-rendering.ts";
import { getFooterRoute } from "../src/footer-session-status.ts";
import type { FooterContext } from "../src/footer-model.ts";
import { DEFAULT_FOOTER_CONFIG } from "../src/settings.ts";

const repeats = Number(process.argv[2] ?? 5);
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 100)
    throw new RangeError("Benchmark repeats must be an integer from 1 through 100");

console.log(JSON.stringify({ node: process.version, repeats, redraws: 100 }));

for (const size of [1000, 10000, 30000]) {
    const session = SessionManager.inMemory("/synthetic-performance");
    for (let index = 0; index < size; index += 1)
        session.appendMessage({
            role: "assistant",
            api: "openai-responses",
            provider: "synthetic",
            model: "physical",
            content: [{ type: "text", text: `Invented content ${index}` }],
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 0,
        });

    let projections = 0;
    const manager = {
        getSessionId: () => session.getSessionId(),
        getLeafId: () => session.getLeafId(),
        buildSessionProjection() {
            projections += 1;
            return session.buildSessionProjection();
        },
    };
    const context: FooterContext = {
        cwd: "/synthetic-performance",
        model: { api: "pi-virtual", provider: "router", id: "auto" },
        sessionManager: manager,
        getContextUsage: () => undefined,
    };
    const footer = createFooterComponent(
        context,
        {
            getGitBranch: () => null,
            getExtensionStatuses: () => new Map(),
            onBranchChange: () => () => {},
        },
        () => "medium",
        () => {},
        {
            ...DEFAULT_FOOTER_CONFIG,
            showGitAheadBehind: false,
            layout: { left: ["model"], right: [], hidden: [] },
        },
    );

    try {
        for (let repeat = 0; repeat < repeats; repeat += 1) {
            projections = 0;
            global.gc?.();

            const started = performance.now();
            let output: string[] = [];
            for (let redraw = 0; redraw < 100; redraw += 1) output = footer.render(120);
            const ms = performance.now() - started;
            const measuredProjections = projections;

            assert.deepEqual(getFooterRoute(context), {
                provider: "synthetic",
                id: "physical",
                thinkingLevel: undefined,
            });

            console.log(
                JSON.stringify({
                    size,
                    repeat,
                    ms,
                    projections: measuredProjections,
                    digest: createHash("sha256").update(JSON.stringify(output)).digest("hex"),
                }),
            );
        }
    } finally {
        footer.dispose();
    }
}
