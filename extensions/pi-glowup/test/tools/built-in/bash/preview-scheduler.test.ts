import { describe, expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { keyText, keyHint, Theme } from "@earendil-works/pi-coding-agent";
import { TEST_THEME_BACKGROUND_COLORS, TEST_THEME_COLORS } from "../../../support/theme-colors.ts";
import {
    parseScriptFormatterCommandsValue,
    type ScriptBlockFormatter,
    type ScriptBlockFormatterOptions,
} from "../../../../src/tools/built-in/bash/formatter.ts";
import { createNativeBashFeature } from "../../../../src/tools/built-in/bash/preview.ts";
import { createCodemodePreview } from "../../../../src/tools/external/codemode.ts";
import type { CodePreview } from "../../../../src/rendering/streaming/presentation.ts";

function deferred<T>() {
    let resolve = (_value: T) => {};
    const promise = new Promise<T>((finish) => {
        resolve = finish;
    });

    return { promise, resolve };
}

// Keep the same observable transition pattern for both schedulers, without
// combining their different width discovery and publication policies.
describe.each(["bash", "codemode"])("%s preview scheduler ownership", (kind) => {
    function createOwner() {
        const bash = createNativeBashFeature();
        const codemode = createCodemodePreview();
        const invalidations = vi.fn<() => void>();
        const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");
        const read = (source = "original", width = 60) => {
            if (kind === "codemode") return codemode.get("call", source);

            const command = `node -e '${source}'`;

            return stripVTControlCharacters(
                bash
                    .renderBashCall(
                        { command },
                        theme,
                        {
                            args: { command },
                            toolCallId: "call",
                            cwd: "/work",
                            lastComponent: undefined,
                            state: {},
                            executionStarted: true,
                            argsComplete: true,
                            isPartial: true,
                            expanded: false,
                            showImages: false,
                            isError: false,
                            durationMs: undefined,
                            outputPad: 1,
                            keyText,
                            keyHint,
                            invalidate: () => {},
                        },
                        () => 8,
                        () => false,
                        () => "preserve",
                        () => "trailing",
                    )
                    .render(width)
                    .join("\n"),
            );
        };

        return {
            invalidations,
            read,
            schedule(
                formatter: ScriptBlockFormatter,
                signal?: AbortSignal,
                source = "original",
                completed = true,
            ) {
                const options = {
                    toolCallId: "call",
                    formatter,
                    completed,
                    isCurrent: () => true,
                    invalidate: invalidations,
                };
                if (kind === "bash") {
                    bash.schedule({ ...options, signal, command: `node -e '${source}'` });
                } else {
                    codemode.schedule({
                        ...options,
                        code: source,
                        ...(signal !== undefined && { signal }),
                    });
                    codemode.get("call", source, {
                        contentWidth: 60,
                        completed,
                        expanded: false,
                    });
                }
            },
            clear() {
                bash.clear();
                codemode.clear();
            },
            async settled() {
                await bash.settled();
            },
        };
    }

    it("replaces a formatter/profile for unchanged source", async () => {
        const owner = createOwner();
        const pending = deferred<string | undefined>();
        const attempts: Array<ScriptBlockFormatterOptions | undefined> = [];
        const first: ScriptBlockFormatter = async (_input, options) => {
            attempts.push(options);
            return pending.promise;
        };

        const replacement = vi.fn<ScriptBlockFormatter>(async () => "replacement");
        try {
            owner.schedule(first);
            await vi.waitUntil(() => attempts.length === 1);
            owner.schedule(replacement);
            await vi.waitUntil(() => replacement.mock.calls.length === 1);
            expect(attempts[0]?.signal?.aborted).toBe(true);
        } finally {
            pending.resolve("obsolete");
            owner.clear();
            await owner.settled();
        }
    });

    it("replaces unchanged source when its owning signal changes", async () => {
        const owner = createOwner();
        const pending = deferred<string | undefined>();
        const attempts: Array<ScriptBlockFormatterOptions | undefined> = [];
        const formatter: ScriptBlockFormatter = async (_input, options) => {
            attempts.push(options);
            return pending.promise;
        };
        try {
            owner.schedule(formatter, new AbortController().signal);
            await vi.waitUntil(() => attempts.length === 1);
            owner.schedule(formatter, new AbortController().signal);
            await vi.waitUntil(() => attempts.length === 2);
            expect(attempts[0]?.signal?.aborted).toBe(true);
            expect(attempts[1]?.signal?.aborted).toBe(false);
        } finally {
            pending.resolve("obsolete");
            owner.clear();
            await owner.settled();
        }
    });

    it.each(["format-first", "execution-first"])(
        "publishes profiled output once with %s completion",
        async (order) => {
            const owner = createOwner();
            const pending = deferred<string | undefined>();
            const started = deferred<void>();
            const profiles = parseScriptFormatterCommandsValue({
                javascript: { kind: "command", command: ["unused"] },
            });
            const formatter: ScriptBlockFormatter = Object.assign(
                async () => {
                    started.resolve();
                    return pending.promise;
                },
                { profileFor: (language: string) => profiles.get(language) },
            );
            try {
                owner.schedule(formatter, undefined, "original", false);
                await started.promise;
                expect(owner.invalidations).not.toHaveBeenCalled();

                if (order === "execution-first") {
                    owner.schedule(formatter);
                    await flush();
                    expect(owner.invalidations).not.toHaveBeenCalled();
                    pending.resolve("formatted");
                } else {
                    pending.resolve("formatted");
                    await flush();
                    expect(owner.invalidations).not.toHaveBeenCalled();
                    owner.schedule(formatter);
                }

                await vi.waitUntil(() => owner.invalidations.mock.calls.length === 1);
                owner.schedule(formatter);
                await flush();
                expect(owner.invalidations).toHaveBeenCalledTimes(1);
                expect(owner.read()).toContain("formatted");
            } finally {
                pending.resolve(undefined);
                owner.clear();
                await owner.settled();
            }
        },
    );

    it("preserves early unprofiled Bash publication and completion notification", async () => {
        const owner = createOwner();
        const pending = deferred<string | undefined>();
        const started = deferred<void>();
        const formatter: ScriptBlockFormatter = async () => {
            started.resolve();
            return pending.promise;
        };
        try {
            owner.schedule(formatter, undefined, "original", false);
            await started.promise;
            pending.resolve("formatted");
            await flush();

            if (kind === "bash") expect(owner.invalidations).toHaveBeenCalledTimes(1);
            else expect(owner.invalidations).not.toHaveBeenCalled();

            owner.schedule(formatter);
            await flush();

            if (kind === "bash") expect(owner.invalidations).toHaveBeenCalledTimes(2);
            else expect(owner.invalidations).toHaveBeenCalledTimes(1);
        } finally {
            pending.resolve(undefined);
            owner.clear();
            await owner.settled();
        }
    });

    it.each(["source", "reset"])("rejects late output after %s replacement", async (change) => {
        const owner = createOwner();
        const pending = deferred<string | undefined>();
        const started = deferred<void>();
        let signal: AbortSignal | undefined;
        const formatter: ScriptBlockFormatter = async (_input, options) => {
            signal = options?.signal;
            started.resolve();
            return pending.promise;
        };

        const replacement: ScriptBlockFormatter = async () => "replacement";
        try {
            owner.schedule(formatter);
            await started.promise;

            if (change === "reset") owner.clear();
            owner.schedule(replacement, undefined, "different");
            await vi.waitUntil(() => owner.invalidations.mock.calls.length === 1);
            expect(signal?.aborted).toBe(true);
            pending.resolve("obsolete");
            await flush();
            expect(owner.invalidations).toHaveBeenCalledTimes(1);
            expect(owner.read("different")).toContain("replacement");
            expect(owner.read("different")).not.toContain("obsolete");
        } finally {
            pending.resolve(undefined);
            owner.clear();
            await owner.settled();
        }
    });
});

it.each(["declared-shell", "stream-code"])(
    "waits for execution completion after an active %s call renders complete arguments",
    async (kind) => {
        const pending = deferred<string | undefined>();
        const started = deferred<void>();
        const profiles = parseScriptFormatterCommandsValue({
            javascript: { kind: "command", command: ["unused"] },
        });
        const formatter: ScriptBlockFormatter = Object.assign(
            async () => {
                started.resolve();
                return pending.promise;
            },
            { profileFor: (language: string) => profiles.get(language) },
        );
        const owner = createNativeBashFeature(() => formatter);
        const invalidations = vi.fn<() => void>();
        const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");
        const command = "node -e 'original'";
        let streamCode: CodePreview | undefined;
        if (kind === "stream-code") streamCode = ({ source }) => source;

        const read = (completed: boolean) =>
            stripVTControlCharacters(
                owner
                    .renderBashCall(
                        { command },
                        theme,
                        {
                            args: { command },
                            toolCallId: "active-call",
                            cwd: "/work",
                            lastComponent: undefined,
                            state: {},
                            executionStarted: true,
                            argsComplete: true,
                            isPartial: !completed,
                            expanded: false,
                            showImages: false,
                            isError: false,
                            durationMs: undefined,
                            outputPad: 1,
                            keyText,
                            keyHint,
                            invalidate: () => {},
                            ...(kind === "declared-shell" && {
                                shellCall: { kind: "bash" as const },
                            }),
                            ...(completed && { result: { content: [] } }),
                        },
                        () => 8,
                        () => false,
                        () => "preserve",
                        () => "trailing",
                        streamCode,
                    )
                    .render(60)
                    .join("\n"),
            );
        try {
            owner.schedule({
                toolCallId: "active-call",
                command,
                formatter,
                signal: undefined,
                completed: false,
                isCurrent: () => true,
                invalidate: invalidations,
            });
            await started.promise;
            read(false);
            pending.resolve("formatted");
            await owner.settled();
            await flush();
            expect(invalidations).not.toHaveBeenCalled();
            expect(read(false)).not.toContain("formatted");
            expect(read(true)).toContain("formatted");
            await flush();
            expect(invalidations).toHaveBeenCalledTimes(1);
        } finally {
            pending.resolve(undefined);
            owner.clear();
            await owner.settled();
        }
    },
);

async function flush(): Promise<void> {
    await new Promise<void>((resolve) => {
        setImmediate(resolve);
    });
}
