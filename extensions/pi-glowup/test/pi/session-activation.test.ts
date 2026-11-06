import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installGlowup } from "../../src/pi/lifecycle.ts";
import * as configuration from "../../src/config/load.ts";
import * as assistant from "../../src/rendering/streaming/assistant-streaming.ts";
import * as syntaxLifecycle from "../../src/pi/syntax-lifecycle.ts";
import * as rendering from "../../src/rendering/presentation-registry.ts";
import * as nativeEdit from "../../src/tools/built-in/edit.ts";
import * as streams from "../../src/rendering/streaming/code-stream.ts";
import * as contentPresentation from "../../src/rendering/streaming/content-presentation.ts";
import * as formatters from "../../src/tools/built-in/bash/formatter.ts";
import type { CodeStreamStore } from "../../src/rendering/streaming/code-stream.ts";
import {
    createExtensionContext,
    ExtensionRegistrationFixture,
} from "../support/sdk-extension-fixture.ts";

function deferred<T>() {
    let resolve: (value: T) => void = () => {
        throw new Error("Deferred resolver is not initialized");
    };

    const promise = new Promise<T>((done) => {
        resolve = done;
    });

    return { promise, resolve };
}

class SessionFixture extends ExtensionRegistrationFixture {
    async start(context: ExtensionContext): Promise<void> {
        for (const registration of this.registrations) {
            if (registration[0] === "session_start")
                await registration[1]({ type: "session_start", reason: "startup" }, context);
        }
    }

    async shutdown(context: ExtensionContext): Promise<void> {
        for (const registration of this.registrations) {
            if (registration[0] === "session_shutdown")
                await registration[1]({ type: "session_shutdown", reason: "quit" }, context);
        }
    }

    async editResult(context: ExtensionContext): Promise<void> {
        for (const registration of this.registrations) {
            if (registration[0] === "tool_result")
                await registration[1](
                    {
                        type: "tool_result",
                        toolName: "edit",
                        toolCallId: "old-edit",
                        input: { path: "old.ts", oldText: "old", newText: "new" },
                        content: [{ type: "text", text: "Edited" }],
                        details: { diff: "- 1 old\n+ 1 new" },
                        isError: false,
                    },
                    context,
                );
        }
    }
}

function context(): ExtensionContext {
    const base = createExtensionContext(process.cwd(), { mode: "tui" });
    base.ui.setStatus = vi.fn<ExtensionContext["ui"]["setStatus"]>();
    return base;
}

const subscriptions = new Set<() => void>();
const schedule =
    vi.fn<ReturnType<typeof syntaxLifecycle.createSyntaxLifecycle>["scheduleSyntaxHighlighting"]>();
const cancel = vi.fn<() => void>();
const settle = vi.fn<() => Promise<void>>(async () => {});

beforeEach(() => {
    settle.mockReset().mockResolvedValue(undefined);
    const config = configuration.parseGlowupConfig({
        streaming: { prose: "sentence", code: "block" },
        scriptPreview: { formatters: {} },
    });
    vi.spyOn(configuration, "readGlowupConfig").mockReturnValue(config);
    vi.spyOn(syntaxLifecycle, "createSyntaxLifecycle").mockReturnValue({
        startPendingSyntaxHighlighting: vi.fn<() => void>(),
        scheduleSyntaxHighlighting: schedule,
        cancel,
        settle,
    });

    vi.spyOn(rendering, "observeGlowupRendering").mockImplementation((listener) => {
        subscriptions.add(listener);

        return () => {
            subscriptions.delete(listener);
        };
    });
});

afterEach(() => {
    subscriptions.clear();
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

describe("session activation ownership", () => {
    it("only publishes the newest session after overlapping assistant activation", async () => {
        const first = deferred<{ dispose(): void }>();
        const staleDispose = vi.fn<() => void>();
        const currentDispose = vi.fn<() => void>();
        const install = vi
            .spyOn(assistant, "installAssistantStreaming")
            .mockImplementationOnce(async () => first.promise)
            .mockResolvedValue({ dispose: currentDispose });
        const pi = new SessionFixture();
        const ctx = context();
        installGlowup(pi);
        try {
            const earlier = pi.start(ctx);
            await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
            const latest = pi.start(ctx);
            await vi.waitFor(() => expect(configuration.readGlowupConfig).toHaveBeenCalledTimes(2));
            first.resolve({ dispose: staleDispose });
            await Promise.all([earlier, latest]);

            expect(staleDispose).toHaveBeenCalledTimes(1);
            expect(install).toHaveBeenCalledTimes(2);
            expect(subscriptions.size).toBe(1);
            expect(schedule).toHaveBeenCalledTimes(1);
            expect(currentDispose).not.toHaveBeenCalled();
        } finally {
            first.resolve({ dispose: staleDispose });
            await pi.shutdown(ctx);
        }

        expect(currentDispose).toHaveBeenCalledTimes(1);
        expect(subscriptions.size).toBe(0);
    });

    it("cannot install observers or syntax work after shutdown during activation", async () => {
        const activation = deferred<{ dispose(): void }>();
        const dispose = vi.fn<() => void>();
        const install = vi
            .spyOn(assistant, "installAssistantStreaming")
            .mockImplementation(async () => activation.promise);
        const pi = new SessionFixture();
        const ctx = context();
        installGlowup(pi);
        const start = pi.start(ctx);
        await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
        const shutdown = pi.shutdown(ctx);
        activation.resolve({ dispose });
        await Promise.all([start, shutdown]);

        expect(dispose).toHaveBeenCalledTimes(1);
        expect(subscriptions.size).toBe(0);
        expect(schedule).not.toHaveBeenCalled();
        await pi.shutdown(ctx);
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("drains every retired store before publishing an overlapping replacement", async () => {
        const initialDisposal = deferred<void>();
        const disposals: Array<() => Promise<void>> = [];
        vi.spyOn(streams, "createCodeStreamStore").mockImplementation(() => {
            const index = disposals.length;
            const dispose = vi.fn(async () => {
                if (index === 0) await initialDisposal.promise;
            });
            disposals.push(dispose);
            const store: CodeStreamStore = {
                get: (input) => input.source,
                ready: () => true,
                clear: vi.fn<() => void>(),
                dispose,
                settled: async () => {},
                formatEmbedded: async (input) => input.code,
            };

            return store;
        });
        const install = vi
            .spyOn(assistant, "installAssistantStreaming")
            .mockResolvedValue({ dispose() {} });
        const pi = new SessionFixture();
        const ctx = context();
        installGlowup(pi);
        try {
            const first = pi.start(ctx);
            const second = pi.start(ctx);
            expect(disposals).toHaveLength(3);
            expect(disposals[0]).toHaveBeenCalledTimes(1);
            expect(disposals[1]).toHaveBeenCalledTimes(1);
            await Promise.resolve();
            expect(install).not.toHaveBeenCalled();
            initialDisposal.resolve();
            await Promise.all([first, second]);
            expect(install).toHaveBeenCalledTimes(1);
            expect(schedule).toHaveBeenCalledTimes(1);
            expect(subscriptions.size).toBe(1);
        } finally {
            initialDisposal.resolve();
            await pi.shutdown(ctx);
        }

        for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("waits for a prior shutdown barrier without retiring the new activation", async () => {
        const shutdownBarrier = deferred<void>();
        const dispose = vi.fn<() => void>();
        const install = vi
            .spyOn(assistant, "installAssistantStreaming")
            .mockResolvedValue({ dispose });
        const pi = new SessionFixture();
        const ctx = context();
        installGlowup(pi);
        try {
            await pi.start(ctx);
            settle.mockImplementationOnce(async () => shutdownBarrier.promise);
            const shutdown = pi.shutdown(ctx);
            await vi.waitFor(() => expect(settle).toHaveBeenCalledTimes(1));
            const replacement = pi.start(ctx);
            await Promise.resolve();
            expect(install).toHaveBeenCalledTimes(1);
            shutdownBarrier.resolve();
            await Promise.all([shutdown, replacement]);
            expect(install).toHaveBeenCalledTimes(2);
            expect(dispose).toHaveBeenCalledTimes(1);
            expect(subscriptions.size).toBe(1);
            expect(schedule).toHaveBeenCalledTimes(2);
            expect(cancel).toHaveBeenCalledTimes(3);
        } finally {
            shutdownBarrier.resolve();
            await Promise.all([pi.shutdown(ctx), pi.shutdown(ctx)]);
        }

        expect(dispose).toHaveBeenCalledTimes(2);
        expect(settle).toHaveBeenCalledTimes(2);
        expect(subscriptions.size).toBe(0);
    });

    it("attempts all cleanup and permits a replacement after an assistant disposer throws", async () => {
        const createStore = streams.createCodeStreamStore;
        const disposals: MockInstance<() => Promise<void>>[] = [];
        vi.spyOn(streams, "createCodeStreamStore").mockImplementation(() => {
            const store = createStore();
            disposals.push(vi.spyOn(store, "dispose"));

            return store;
        });
        const dispose = vi.fn<() => void>().mockImplementationOnce(() => {
            throw new Error("component restoration failed");
        });
        vi.spyOn(assistant, "installAssistantStreaming").mockResolvedValue({ dispose });
        const pi = new SessionFixture();
        const ctx = context();
        installGlowup(pi);
        try {
            await pi.start(ctx);
            await expect(pi.shutdown(ctx)).rejects.toThrow();
            expect(disposals[1]).toHaveBeenCalledTimes(1);
            expect(settle).toHaveBeenCalledTimes(1);
            expect(subscriptions.size).toBe(0);
            await pi.start(ctx);
            expect(subscriptions.size).toBe(1);
        } finally {
            await pi.shutdown(ctx).catch(() => {});
        }
    });

    it("does not poison the shutdown barrier when a retired store rejects disposal", async () => {
        const createStore = streams.createCodeStreamStore;
        let count = 0;
        vi.spyOn(streams, "createCodeStreamStore").mockImplementation(() => {
            const store = createStore();
            if (count++ === 1) {
                const dispose = store.dispose.bind(store);
                vi.spyOn(store, "dispose").mockImplementationOnce(async () => {
                    await dispose();
                    throw new Error("store cleanup failed");
                });
            }

            return store;
        });

        vi.spyOn(assistant, "installAssistantStreaming").mockResolvedValue({ dispose() {} });
        const pi = new SessionFixture();
        const ctx = context();
        installGlowup(pi);
        try {
            await pi.start(ctx);
            await expect(pi.shutdown(ctx)).rejects.toThrow();
            expect(settle).toHaveBeenCalledTimes(1);
            await pi.start(ctx);
            expect(subscriptions.size).toBe(1);
        } finally {
            await pi.shutdown(ctx).catch(() => {});
        }
    });

    it("refreshes the owning presentation formatter without changing its stream store", async () => {
        const firstFormatter: formatters.ScriptBlockFormatter = async () => "first";
        const nextFormatter: formatters.ScriptBlockFormatter = async () => "next";
        let selectedFormatter = firstFormatter;
        vi.spyOn(formatters, "createCommandScriptFormatter").mockImplementation(
            () => selectedFormatter,
        );
        const present = contentPresentation.createStreamingPresentation;
        const readers: Array<Parameters<typeof present>[0]> = [];
        vi.spyOn(contentPresentation, "createStreamingPresentation").mockImplementation((read) => {
            readers.push(read);
            return present(read);
        });

        vi.spyOn(assistant, "installAssistantStreaming").mockResolvedValue({ dispose() {} });
        const pi = new SessionFixture();
        const ctx = context();
        installGlowup(pi);
        try {
            await pi.start(ctx);
            const read = readers.at(-1);
            if (read === undefined) throw new Error("Session presentation was not created");

            const ownerStore = read().streams;
            expect(read().formatter).toBe(firstFormatter);
            selectedFormatter = nextFormatter;

            for (const refresh of subscriptions) refresh();
            expect(read().formatter).toBe(nextFormatter);
            expect(read().streams).toBe(ownerStore);
        } finally {
            await pi.shutdown(ctx);
        }
    });

    it("does not remember an old edit result after a session reset", async () => {
        vi.spyOn(assistant, "installAssistantStreaming").mockResolvedValue({ dispose() {} });
        const feature = nativeEdit.createNativeEditFeature();
        const finish = deferred<undefined>();
        vi.spyOn(feature, "finishNativeEditSnapshot").mockImplementation(
            async () => finish.promise,
        );
        const remember = vi.spyOn(feature, "rememberCompletedPreview");
        vi.spyOn(nativeEdit, "createNativeEditFeature").mockReturnValue(feature);
        const pi = new SessionFixture();
        const ctx = context();
        installGlowup(pi);
        try {
            await pi.start(ctx);
            const result = pi.editResult(ctx);
            await pi.start(ctx);
            finish.resolve(undefined);
            await result;
            expect(remember).not.toHaveBeenCalled();
        } finally {
            finish.resolve(undefined);
            await pi.shutdown(ctx);
        }
    });
});
