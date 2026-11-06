import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { EventEmitter, once } from "node:events";
import { transform } from "esbuild";
import { parse as parseBash } from "unbash";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringParser } from "../../../src/json-scalar.ts";
import {
    configureRenderDiagnostics,
    type ScriptSegmentDiagnostic,
} from "../../../src/diagnostics/render-events.ts";
import {
    createCodeStreamStore,
    type CodeStreamStore,
    type CodeStreamInput,
} from "../../../src/rendering/streaming/code-stream.ts";
import {
    createCommandScriptFormatter,
    parseScriptFormatterCommandsValue,
    type ScriptBlockFormatter,
} from "../../../src/tools/built-in/bash/formatter.ts";

// Failure matrix: independent formatting at final/resize/history, stale async results,
// append versus rewrite, key isolation, abort/clear/dispose, undefined-width stability.
// Completed calls must replace partial units atomically with one whole-program job.
const stores: CodeStreamStore[] = [];
const directories: string[] = [];
afterEach(async () => {
    await Promise.all(stores.splice(0).map(async (store) => store.dispose()));

    for (const directory of directories.splice(0))
        rmSync(directory, { recursive: true, force: true });
});
function store(): CodeStreamStore {
    const result = createCodeStreamStore();
    stores.push(result);
    return result;
}

function journalInputs(log: string): string[] {
    return readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
            const value = stringParser.parse(JSON.parse(line));
            if (value === undefined) throw new Error("Invalid formatter input journal");
            return value;
        });
}

function formatter() {
    const directory = mkdtempSync(
        join(fileURLToPath(new URL("../../../.cache/", import.meta.url)), "glowup-statements-"),
    );
    directories.push(directory);
    const log = join(directory, "inputs.jsonl");

    // Real esbuild printer, with an input journal to verify subprocess isolation.
    const program = `const fs=require('node:fs');const esbuild=require(${JSON.stringify(import.meta.resolve("esbuild").replace("file://", ""))});const code=fs.readFileSync(0,'utf8');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(code)+'\\n');process.stdout.write(esbuild.transformSync(code,{loader:'ts',legalComments:'inline'}).code);`;
    const result = createCommandScriptFormatter(
        parseScriptFormatterCommandsValue({
            javascript: { kind: "command", command: [process.execPath, "-e", program] },
            typescript: { kind: "command", command: [process.execPath, "-e", program] },
        }),
    );
    if (result === undefined) throw new Error("formatter configuration rejected");
    return {
        result,
        inputs: () => journalInputs(log),
    };
}

type PendingFormat = {
    readonly code: string;
    readonly width: number | undefined;
    readonly signal: AbortSignal | undefined;
    readonly finish: (text: string) => void;
};

function controlledFormatter() {
    const calls: PendingFormat[] = [];
    const pending: PendingFormat[] = [];
    let waiting: ((call: PendingFormat) => void) | undefined;
    const formatter: ScriptBlockFormatter = async (input, options) =>
        new Promise<string>((finish) => {
            const call = {
                code: input.code,
                width: options?.targetWidth,
                signal: options?.signal,
                finish,
            };
            calls.push(call);

            if (waiting === undefined) pending.push(call);
            else {
                const receive = waiting;
                waiting = undefined;
                receive(call);
            }
        });

    const next = async (): Promise<PendingFormat> => {
        const call = pending.shift();
        if (call !== undefined) return call;

        return new Promise((resolve) => {
            waiting = resolve;
        });
    };

    return { formatter, calls, next };
}

describe("code stream store", () => {
    it("returns token mode immediately and holds block mode until independently ready", async () => {
        const subject = store();
        const input = { key: "a", source: "let x=1;", complete: false, mode: "token" as const };
        expect(subject.get(input)).toBe(input.source);
        expect(subject.get({ ...input, mode: "block" })).toBe("");
        await subject.settled();
        expect(subject.get({ ...input, mode: "block" })).toBe("");
        subject.get({ ...input, mode: "block", complete: true });
        await subject.settled();
        expect(subject.get({ ...input, mode: "block", complete: true })).toBe(input.source);
    });

    it("formats live statements separately and final/resize as whole programs", async () => {
        const subject = store();
        const external = formatter();
        const input = {
            key: "script",
            toolCallId: "script-call",
            source: "const x=1;",
            language: "ts",
            complete: false,
            mode: "statement" as const,
            formatter: external.result,
        };
        expect(subject.get(input)).toBe("");
        await subject.settled();
        expect(subject.get(input)).toBe("const x = 1;");
        const appended = { ...input, source: "const x=1;\nconst y=2;" };
        subject.get(appended);
        await subject.settled();
        expect(subject.get(appended)).toBe("const x = 1;\nconst y = 2;");
        subject.get({ ...appended, complete: true });
        await subject.settled();
        subject.get({ ...appended, complete: true, targetWidth: 60 });
        await subject.settled();
        expect(external.inputs()).toEqual([
            "const x=1;",
            "const y=2;",
            appended.source,
            appended.source,
        ]);
    });

    it.each([
        ["if check; then\n  echo one\n", "fi"],
        ["for x in a; do\n  echo x\n", "done"],
        ["while check; do\n  echo x\n", "done"],
        ["case value in\n  a) echo x;;\n", "esac"],
        ["f() {\n  echo x\n", "}"],
        ["(echo x;\n", ")"],
    ])("only sends complete compound Bash programs to a live formatter", async (prefix, close) => {
        const subject = store();
        const received: string[] = [];
        const formatter = async ({ code }: { code: string }) => {
            received.push(code);
            return code;
        };
        const input = {
            key: "live-compound",
            source: prefix,
            language: "bash",
            complete: false,
            mode: "statement" as const,
            formatter,
        };
        subject.get(input);
        await subject.settled();
        expect(received).toEqual([]);
        const next = { ...input, source: `${prefix}${close}\necho next` };
        subject.get(next);
        await subject.settled();
        expect(received).toHaveLength(1);
        expect(received[0]).toContain(close);
        expect(parseBash(received[0] ?? "").errors ?? []).toEqual([]);
    });

    it("formats embedded code against the original Bash source before outer shell formatting", async () => {
        const subject = store();
        const pythonInputs: string[] = [];
        const formatter = async ({ language, code }: { language: string; code: string }) => {
            if (language === "python") {
                pythonInputs.push(code);
                return code.replace("a=1", "a = 1");
            }

            if (language === "bash") return code.replace("a=1", "a  =  1");
            return undefined;
        };

        const source = `python -c 'a=1'; echo done`;
        const input = {
            key: "embedded-identity",
            source,
            language: "bash",
            complete: true,
            mode: "block" as const,
            formatter,
        };
        subject.get(input);
        await subject.settled();
        expect(pythonInputs).toEqual(["a=1"]);
        expect(subject.get(input)).toContain("'a = 1'");
    });

    it("formats embedded code before its live Bash statement", async () => {
        const subject = store();
        const pythonInputs: string[] = [];
        const formatter = async ({ language, code }: { language: string; code: string }) => {
            if (language === "python") {
                pythonInputs.push(code);
                return code.replace("a=1", "a = 1");
            }

            if (language === "bash") return code.replace("a=1", "a  =  1");
            return undefined;
        };
        const input = {
            key: "embedded-live",
            source: `python -c 'a=1';\necho next`,
            language: "bash",
            complete: false,
            mode: "statement" as const,
            formatter,
        };
        subject.get(input);
        await subject.settled();
        expect(pythonInputs).toEqual(["a=1"]);
        expect(subject.get(input)).toContain("'a = 1'");
    });

    it("reports live embedded ranges against the original complete input", async () => {
        const subject = store();
        const segments: ScriptSegmentDiagnostic[] = [];
        const source = `echo first;\npython -c 'a=1';\necho next`;
        configureRenderDiagnostics(() => {});
        try {
            subject.get({
                key: "embedded-ranges",
                source,
                language: "bash",
                complete: false,
                mode: "statement",
                formatter: async ({ code }) => code,
                diagnostics: {
                    recordSegment: (segment) => {
                        segments.push(segment);
                    },
                },
            });
            await subject.settled();
            const python = segments.find((segment) => segment.language === "python");
            if (python?.start === undefined || python.end === undefined)
                throw new Error("Expected Python source range");

            expect(source.slice(python.start, python.end)).toBe("'a=1'");
        } finally {
            configureRenderDiagnostics(undefined);
        }
    });

    it("formats completed compound shells once without statement fragments", async () => {
        const subject = store();
        const inputs: string[] = [];
        const source = "if true; then echo one; else echo two; fi";
        const input = {
            key: "compound",
            toolCallId: "compound-call",
            source,
            language: "bash",
            complete: true,
            mode: "statement" as const,
            formatter: async (value: { code: string }) => {
                inputs.push(value.code);
                return "if true; then\n  echo one\nelse\n  echo two\nfi";
            },
        };
        subject.get(input);
        await subject.settled();
        expect(inputs).toEqual([source]);
        expect(subject.get(input)).toContain("\n  echo one\n");
        expect(subject.ready(input.key)).toBe(true);
    });

    it("coalesces resize targets without aborting in-flight completed formatting", async () => {
        const subject = store();
        const widths: Array<number | undefined> = [];
        const signals: AbortSignal[] = [];
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const input = {
            key: "resizing",
            toolCallId: "resize-call",
            source: "const value=1;",
            language: "javascript",
            complete: true,
            mode: "statement" as const,
            targetWidth: 80,
            formatter: async (
                _value: { code: string },
                options?: { targetWidth?: number; signal?: AbortSignal },
            ) => {
                widths.push(options?.targetWidth);

                if (options?.signal !== undefined) signals.push(options.signal);
                if (widths.length === 1) await gate;
                return `width${options?.targetWidth}`;
            },
        };
        subject.get(input);
        subject.get({ ...input, targetWidth: 40 });
        subject.get({ ...input, targetWidth: 60 });
        expect(signals[0]?.aborted).toBe(false);
        release();
        await subject.settled();
        expect(widths).toEqual([80, 60]);
        expect(signals.every((signal) => !signal.aborted)).toBe(true);
        expect(subject.get({ ...input, targetWidth: 60 })).toBe("width60");
    });

    it("withdraws display readiness when a published result synchronously requests a resize", async () => {
        const subject = store();
        const widths: Array<number | undefined> = [];
        const readiness: boolean[] = [];
        const input: CodeStreamInput = {
            key: "reentrant-ready",
            source: "const value=1;",
            language: "javascript",
            mode: "block",
            complete: true,
            targetWidth: 80,
            formatter: async (_input, options) => {
                widths.push(options?.targetWidth);
                return `width${options?.targetWidth}`;
            },
        };
        const latest = { ...input, targetWidth: 40 };
        subject.get({
            ...input,
            invalidate: () => {
                expect(subject.get(latest)).toBe("width80");
                readiness.push(subject.ready(input.key));
            },
        });
        await subject.settled();
        expect(readiness).toEqual([false]);
        expect(widths).toEqual([80, 40]);
        expect(subject.get(latest)).toBe("width40");
        expect(subject.ready(input.key)).toBe(true);
    });

    it("atomically rebuilds the latest width after append and completion during formatting", async () => {
        const subject = store();
        const external = controlledFormatter();
        const first = "const first=1;";
        const input: CodeStreamInput = {
            key: "resize-append-complete",
            source: first,
            language: "javascript",
            mode: "statement",
            complete: false,
            targetWidth: 80,
            formatter: external.formatter,
        };
        subject.get(input);
        (await external.next()).finish("const first = 1;");
        await subject.settled();
        const visible = subject.get(input);
        const appended = { ...input, source: `${first}\nconst second=2;` };
        expect(subject.get(appended)).toBe(visible);
        const stale = await external.next();
        expect(subject.get({ ...appended, targetWidth: 40 })).toBe(visible);
        const latest = {
            ...appended,
            source: `${appended.source}\nconst third=3;`,
            targetWidth: 40,
            complete: true,
        };
        expect(subject.get(latest)).toBe(visible);
        expect(subject.ready(input.key)).toBe(false);
        expect(stale.signal?.aborted).toBe(false);
        stale.finish("stale width80");

        for (const name of ["first", "second", "third"]) {
            const call = await external.next();
            expect(call.width).toBe(40);
            expect(call.code).toContain(`const ${name}=`);
            expect(subject.get(latest)).toBe(visible);
            expect(subject.ready(input.key)).toBe(false);
            call.finish(`const ${name} = 40;`);
        }

        await subject.settled();
        expect(subject.get(latest)).toBe(
            "const first = 40;\nconst second = 40;\nconst third = 40;",
        );

        expect(subject.ready(input.key)).toBe(true);
        expect(external.calls.map((call) => call.width)).toEqual([80, 80, 40, 40, 40]);
    });

    it.each(["clear", "cancel"])(
        "retires a pending resize on %s before a same-key replacement publishes",
        async (retirement) => {
            const subject = store();
            const external = controlledFormatter();
            const owner = new AbortController();
            const replacementOwner = new AbortController();
            let invalidations = 0;
            const input: CodeStreamInput = {
                key: "resize-retire",
                source: "const value=1;",
                language: "javascript",
                mode: "block",
                complete: true,
                targetWidth: 80,
                signal: owner.signal,
                formatter: external.formatter,
                invalidate: () => {
                    invalidations += 1;
                },
            };
            subject.get(input);
            (await external.next()).finish("original width80");
            await subject.settled();
            expect(subject.get({ ...input, targetWidth: 40 })).toBe("original width80");
            const stale = await external.next();
            expect(subject.get({ ...input, targetWidth: 20 })).toBe("original width80");

            if (retirement === "clear") subject.clear();
            else owner.abort();

            expect(stale.signal?.aborted).toBe(true);
            expect(subject.ready(input.key)).toBe(false);

            const latest = { ...input, targetWidth: 60, signal: replacementOwner.signal };
            expect(subject.get(latest)).toBe("");
            const fresh = await external.next();
            stale.finish("late width40");
            expect(subject.get(latest)).toBe("");
            fresh.finish("replacement width60");
            await subject.settled();
            expect(subject.get(latest)).toBe("replacement width60");
            expect(subject.ready(input.key)).toBe(true);
            expect(invalidations).toBe(2);
            expect(external.calls.map((call) => call.width)).toEqual([80, 40, 60]);
        },
    );

    it("keeps the visible revision through an in-flight formatter profile replacement", async () => {
        const subject = store();
        const previous = controlledFormatter();
        const replacement = controlledFormatter();
        const input: CodeStreamInput = {
            key: "profile-replacement",
            source: "const value=1;",
            language: "javascript",
            mode: "block",
            complete: true,
            targetWidth: 80,
            formatter: previous.formatter,
        };
        subject.get(input);
        (await previous.next()).finish("original");
        await subject.settled();
        expect(subject.get({ ...input, targetWidth: 40 })).toBe("original");
        const stale = await previous.next();
        const latest = { ...input, targetWidth: 40, formatter: replacement.formatter };
        expect(subject.get(latest)).toBe("original");
        expect(subject.ready(input.key)).toBe(false);
        expect(stale.signal?.aborted).toBe(true);
        const fresh = await replacement.next();
        stale.finish("stale profile");
        expect(subject.get(latest)).toBe("original");
        fresh.finish("new profile");
        await subject.settled();
        expect(subject.get(latest)).toBe("new profile");
        expect(subject.ready(input.key)).toBe(true);
    });

    it.each(["const first=1;", "const fresh=3;"])(
        "resets consumed boundaries on a pending append replaced with %s",
        async (source) => {
            const subject = store();
            const external = controlledFormatter();
            const input: CodeStreamInput = {
                key: "source-replacement",
                source: "const first=1;",
                language: "javascript",
                mode: "statement",
                complete: false,
                formatter: external.formatter,
            };
            subject.get(input);
            (await external.next()).finish("const first = 1;");
            await subject.settled();
            subject.get({ ...input, source: `${input.source}\nconst second=2;` });
            const stale = await external.next();
            const latest = { ...input, source, complete: true };
            expect(subject.get(latest)).toBe("");
            expect(subject.ready(input.key)).toBe(false);
            expect(stale.signal?.aborted).toBe(true);
            const fresh = await external.next();
            expect(fresh.code).toBe(source);
            stale.finish("stale append");
            fresh.finish(source);
            await subject.settled();
            expect(subject.get(latest)).toBe(source);
            expect(subject.ready(input.key)).toBe(true);
        },
    );

    // Handoff failures: late width/source updates must not be mistaken for work
    // already consumed; rejection, processing errors and disposal must remain terminal.
    it("processes the latest resize arriving during the running-to-idle handoff", async () => {
        const subject = store();
        const widths: Array<number | undefined> = [];
        let injected = false;

        const input = {
            key: "handoff-width",
            toolCallId: "handoff-width",
            source: "const value=1;",
            language: "javascript",
            mode: "statement" as const,
            complete: true,
            targetWidth: 80,
            formatter: async (_input: { code: string }, options?: { targetWidth?: number }) => {
                widths.push(options?.targetWidth);
                return `width${options?.targetWidth}`;
            },
        };
        const latest = { ...input, targetWidth: 60 };
        subject.get({
            ...input,
            invalidate: () => {
                if (injected) return;

                injected = true;
                queueMicrotask(() =>
                    queueMicrotask(() => {
                        subject.get(latest);
                    }),
                );
            },
        });
        await subject.settled();
        expect(subject.get(latest)).toBe("width60");
        expect(widths).toEqual([80, 60]);
        expect(subject.ready(input.key)).toBe(true);
    });

    it("consumes an append arriving during the running-to-idle handoff", async () => {
        const subject = store();
        const inputs: string[] = [];
        let injected = false;

        const input = {
            key: "handoff-append",
            source: "const first=1;",
            language: "javascript",
            mode: "statement" as const,
            complete: false,
            formatter: async ({ code }: { code: string }) => {
                inputs.push(code);
                return code;
            },
        };
        const latest = { ...input, source: input.source + "\nconst second=2;", complete: true };
        subject.get({
            ...input,
            invalidate: () => {
                if (injected) return;

                injected = true;
                queueMicrotask(() =>
                    queueMicrotask(() => {
                        subject.get(latest);
                    }),
                );
            },
        });
        await subject.settled();
        expect(subject.get(latest)).toBe(latest.source);
        expect(inputs).toEqual([input.source, "const second=2;"]);
        expect(subject.ready(input.key)).toBe(true);
    });

    it.each(["decline", "reject", "processing-error"])(
        "does not restart %s work on redraw",
        async (failure) => {
            const subject = store();
            let calls = 0;
            let redraws = 0;

            const backend = Object.assign(
                async () => {
                    calls += 1;

                    if (failure === "reject") throw new Error("Formatter rejected input");
                    return undefined;
                },
                {
                    profileFor: () => {
                        throw new Error("Profile unavailable");
                    },
                },
            );
            const input = {
                key: "terminal-failure",
                source: "jq '.items[]' data.json",
                language: "javascript",
                mode: "block" as const,
                complete: true,
                formatter: backend,
            };
            if (failure === "processing-error") input.language = "bash";

            const redraw = (): void => {
                redraws += 1;
                queueMicrotask(() =>
                    queueMicrotask(() => {
                        subject.get({ ...input, invalidate: redraw });
                    }),
                );
            };
            subject.get({ ...input, invalidate: redraw });
            await subject.settled();
            expect(subject.get(input)).toBe(input.source);
            expect(calls).toBe(1);
            expect(redraws).toBe(1);
            expect(subject.ready(input.key)).toBe(true);
        },
    );

    it("does not restart a late resize after disposal", async () => {
        const subject = store();
        const widths: Array<number | undefined> = [];
        let closing: Promise<void> | undefined;
        const input = {
            key: "handoff-dispose",
            source: "const value=1;",
            language: "javascript",
            mode: "block" as const,
            complete: true,
            targetWidth: 80,
            formatter: async (_input: { code: string }, options?: { targetWidth?: number }) => {
                widths.push(options?.targetWidth);
                return `width${options?.targetWidth}`;
            },
        };
        subject.get({
            ...input,
            invalidate: () => {
                queueMicrotask(() => {
                    closing = subject.dispose();
                    queueMicrotask(() => {
                        subject.get({ ...input, targetWidth: 40 });
                    });
                });
            },
        });
        await subject.settled();
        await closing;
        expect(subject.get({ ...input, targetWidth: 40 })).toBe("");
        expect(widths).toEqual([80]);
        expect(subject.ready(input.key)).toBe(false);
    });

    it("discards a pending resize and late formatter completion on disposal", async () => {
        const subject = store();
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const widths: Array<number | undefined> = [];
        let invalidations = 0;
        const input = {
            key: "disposed-resize",
            source: "const value=1;",
            language: "javascript",
            mode: "block" as const,
            complete: true,
            targetWidth: 80,
            invalidate: () => {
                invalidations += 1;
            },
            formatter: async (_input: { code: string }, options?: { targetWidth?: number }) => {
                widths.push(options?.targetWidth);
                await gate;
                return "late output";
            },
        };
        try {
            subject.get(input);
            subject.get({ ...input, targetWidth: 40 });
            await subject.dispose();
            release();
            await gate;
            await subject.settled();
            expect(widths).toEqual([80]);
            expect(invalidations).toBe(0);
            expect(subject.get({ ...input, targetWidth: 40 })).toBe("");
        } finally {
            release();
        }
    });

    it("retires an owner without letting its signal or later renders cancel a replacement", async () => {
        const subject = store();
        const previous = new AbortController();
        const replacement = new AbortController();
        const calls: AbortSignal[] = [];
        const input = {
            key: "owned-source",
            source: "const value=1;",
            language: "javascript",
            mode: "block" as const,
            complete: true,
            signal: previous.signal,
            formatter: async ({ code }: { code: string }, options?: { signal?: AbortSignal }) => {
                if (options?.signal !== undefined) calls.push(options.signal);
                return code;
            },
        };
        subject.get(input);
        await subject.settled();
        subject.get({ ...input, signal: replacement.signal });
        await subject.settled();
        previous.abort();
        expect(calls).toHaveLength(2);
        expect(calls[0]?.aborted).toBe(true);
        expect(calls[1]?.aborted).toBe(false);
        expect(subject.get(input)).toBe("");
        expect(subject.get({ ...input, signal: replacement.signal })).toBe(input.source);
        expect(subject.ready(input.key)).toBe(true);
        replacement.abort();
        expect(calls[1]?.aborted).toBe(true);
        expect(subject.ready(input.key)).toBe(false);
        expect(subject.get({ ...input, signal: replacement.signal })).toBe("");
        expect(calls).toHaveLength(2);
    });

    it("does not start a source retired synchronously while replacing its predecessor", async () => {
        const subject = store();
        const previous = new AbortController();
        const replacement = new AbortController();
        let calls = 0;
        const input = {
            key: "reentrant-retirement",
            source: "const value=1;",
            language: "javascript",
            mode: "block" as const,
            complete: true,
            signal: previous.signal,
            formatter: async ({ code }: { code: string }, options?: { signal?: AbortSignal }) => {
                calls += 1;
                options?.signal?.addEventListener("abort", () => replacement.abort(), {
                    once: true,
                });

                return code;
            },
        };
        subject.get(input);
        await subject.settled();
        expect(subject.get({ ...input, signal: replacement.signal })).toBe("");
        await subject.settled();
        expect(replacement.signal.aborted).toBe(true);
        expect(subject.ready(input.key)).toBe(false);
        expect(calls).toBe(1);
    });

    it.each([
        ["const before=1;try { work(); } catch { recover(); }", "const before = 1;\ntry {"],
        [
            "const lines=render();bench(name, () => { work(); });",
            "const lines = render();\nbench(name, () => {",
        ],
        [
            "for(let i=0;i<2;i++){ work();next(); }",
            "for (let i = 0; i < 2; i++) {\n  work();\n  next();\n}",
        ],
    ])(
        "separates formatted JavaScript siblings without splitting loop headers: %s",
        async (source, expected) => {
            const subject = store();
            const input = {
                key: "inline-siblings",
                source,
                language: "javascript",
                mode: "statement" as const,
                complete: true,
                formatter: async ({ code }: { code: string }) =>
                    (await transform(code, { loader: "ts", legalComments: "inline" })).code,
            };
            subject.get(input);
            await subject.settled();
            expect(subject.get(input)).toContain(expected);
            expect(subject.ready(input.key)).toBe(true);
        },
    );

    it.each(["function read() { return 1; }", "class Reader { read() { return 1; } }"])(
        "preserves lexical whitespace after export in multiline gaps: %s",
        async (declaration) => {
            const subject = store();
            const input = {
                key: "export-gap",
                source: `const value=1;\n\nexport ${declaration}`,
                language: "typescript",
                mode: "statement" as const,
                complete: true,
                formatter: async ({ code }: { code: string }) =>
                    (await transform(code, { loader: "ts", legalComments: "inline" })).code,
            };
            subject.get(input);
            await subject.settled();
            const display = subject.get(input);
            expect(display).toContain(`\n\nexport ${declaration.split(" {")[0]} {`);
            await expect(transform(display, { loader: "ts" })).resolves.toBeDefined();
        },
    );

    it.each([
        "while(true){try{work();}catch{}next();}",
        "while(true){try{work();}catch(error){}next();}",
        "while(true){try{work();}finally{}next();}",
        "while(true){if(ready){work();}else{}next();}",
        "try{work();}catch{}next();",
        "try{work();}finally{}next();",
        "if(ready){work();}else{}next();",
    ])("formats empty JavaScript branches with private grammatical context: %s", async (source) => {
        const subject = store();
        const failures: string[] = [];
        const input = {
            key: "empty-branch",
            source,
            language: "javascript",
            mode: "statement" as const,
            complete: true,
            formatter: async ({ code }: { code: string }) => {
                try {
                    return (await transform(code, { loader: "ts", legalComments: "inline" })).code;
                } catch {
                    failures.push(code);
                    return undefined;
                }
            },
        };
        subject.get(input);
        await subject.settled();
        expect(failures).toEqual([]);
        const canonical = async (code: string) =>
            (await transform(code, { loader: "ts", minifyWhitespace: true })).code;
        expect(await canonical(subject.get(input))).toBe(await canonical(source));
    });

    it("keeps formatting completed statements while later chunks append", async () => {
        const subject = store();
        const gate = new EventEmitter();
        const entered = once(gate, "entered");
        const inputs: string[] = [];
        const first = "const first={value:1};";
        const external = async (input: { code: string }): Promise<string> => {
            inputs.push(input.code);

            if (input.code === first && inputs.length === 1) {
                const released = once(gate, "release");
                gate.emit("entered");
                await released;
            }

            return (await transform(input.code, { loader: "ts" })).code;
        };
        const input = {
            key: "appending",
            source: first,
            language: "javascript",
            mode: "statement" as const,
            complete: false,
            formatter: external,
        };
        subject.get(input);
        await entered;
        const appended = { ...input, source: first + "\nconst second={value:2};\nconst pending =" };
        subject.get(appended);
        gate.emit("release");
        await subject.settled();
        expect(subject.get(appended)).toBe(
            "const first = { value: 1 };\nconst second = { value: 2 };",
        );

        expect(inputs).toEqual([first, "const second={value:2};"]);
    });

    it("uses real oxfmt on each completed statement, never on its growing prefix", async () => {
        const subject = store();
        const directory = mkdtempSync(
            join(fileURLToPath(new URL("../../../.cache/", import.meta.url)), "glowup-oxfmt-"),
        );
        directories.push(directory);
        const log = join(directory, "inputs.jsonl");
        const program = `const fs=require('node:fs');const code=fs.readFileSync(0,'utf8');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(code)+'\\n');import(${JSON.stringify(import.meta.resolve("oxfmt"))}).then(async ({format})=>{const result=await format('unit.js',code,{objectWrap:'collapse'});if(result.errors.length)process.exit(1);process.stdout.write(result.code);});`;
        const external = createCommandScriptFormatter(
            parseScriptFormatterCommandsValue({
                javascript: { kind: "command", command: [process.execPath, "-e", program] },
            }),
        );
        if (external === undefined) throw new Error("formatter configuration rejected");

        const first = "const first={\nx:1\n};";
        const input = {
            key: "oxfmt",
            source: first + "\nconst second={",
            language: "javascript",
            mode: "statement" as const,
            complete: false,
            formatter: external,
        };
        subject.get(input);
        await subject.settled();
        expect(subject.get(input)).toBe("const first = { x: 1 };");
        const final = { ...input, source: first + "\nconst second={y:2};", complete: true };
        subject.get(final);
        await subject.settled();
        expect(subject.get(final)).toBe("const first = { x: 1 };\nconst second = { y: 2 };");
        expect(journalInputs(log)).toEqual([first, "const second={y:2};"]);
    });

    it("formats nested returns without revealing private wrapper closings", async () => {
        const subject = store();
        const external = formatter();
        const input = {
            key: "nested",
            source: "function f(){\n  return x+1;\n",
            path: "a.js",
            mode: "statement" as const,
            complete: false,
            formatter: external.result,
        };
        subject.get(input);
        await subject.settled();
        expect(subject.get(input)).toBe("function f() {\n  return x + 1;");
        const final = { ...input, source: input.source + "}", complete: true };
        subject.get(final);
        await subject.settled();
        expect(subject.get(final)).toBe("function f() {\n  return x + 1;\n}");
        expect(external.inputs()).toHaveLength(2);
    });

    it("does not treat callback changes or undefined width as new formatting jobs", async () => {
        const subject = store();
        const external = formatter();
        const input = {
            key: "a",
            source: "const x=1;",
            path: "a.js",
            complete: true,
            mode: "statement" as const,
            formatter: external.result,
        };
        subject.get(input);
        await subject.settled();
        expect(subject.get({ ...input, invalidate: () => {} })).toBe("const x = 1;");
        await subject.settled();
        expect(external.inputs()).toEqual(["const x=1;"]);
    });

    it("isolates keys and rejects stale work after rewrite/clear/disposal", async () => {
        const subject = store();
        const external = formatter();
        const input = {
            key: "a",
            source: "const old=1;",
            language: "javascript",
            complete: true,
            mode: "statement" as const,
            formatter: external.result,
        };
        subject.get(input);
        subject.get({ ...input, source: "const fresh=2;" });
        subject.get({ ...input, key: "b", source: "const other=3;" });
        await subject.settled();
        expect(subject.get({ ...input, source: "const fresh=2;" })).toBe("const fresh = 2;");
        expect(subject.get({ ...input, key: "b", source: "const other=3;" })).toBe(
            "const other = 3;",
        );

        subject.clear();
        expect(subject.get(input)).toBe("");
        await subject.dispose();
        expect(subject.get(input)).toBe("");
    });

    it.each([
        ["python", 'if True: print("inline")'],
        ["python", 'def read(): return "inline"\nprint(read())'],
        ["python", "def read():\n # first comment\n value=1\n return value\n"],
        ["bash", "if true; then echo one; else echo two; fi"],
        ["javascript", "function f(){ if(true) return 1; else return 2; }"],
    ])(
        "preserves original %s layout when a formatter declines the language",
        async (language, source) => {
            const subject = store();
            const input = {
                key: "unformatted-language",
                source,
                language,
                complete: true,
                mode: "statement" as const,
                formatter: async () => undefined,
            };
            subject.get(input);
            await subject.settled();
            expect(subject.get(input)).toBe(source);
            expect(subject.ready(input.key)).toBe(true);
        },
    );

    it("never mistakes explicit unknown languages for a path alias", async () => {
        const subject = store();
        const input = {
            key: "a",
            source: "x();",
            language: "ruby",
            path: "x.js",
            complete: false,
            mode: "statement" as const,
        };
        subject.get(input);
        await subject.settled();
        expect(subject.get(input)).toBe("");
        subject.get({ ...input, complete: true });
        await subject.settled();
        expect(subject.get({ ...input, complete: true })).toBe("x();");
    });
});
