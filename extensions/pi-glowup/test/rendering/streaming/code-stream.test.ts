import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { EventEmitter, once } from "node:events";
import { transform } from "esbuild";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringParser } from "../../../src/json-scalar.ts";
import {
    createCodeStreamStore,
    type CodeStreamStore,
} from "../../../src/rendering/streaming/code-stream.ts";
import {
    createCommandScriptFormatter,
    parseScriptFormatterCommandsValue,
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
                queueMicrotask(() => queueMicrotask(() => subject.get(latest)));
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
                    queueMicrotask(() => subject.get({ ...input, invalidate: redraw })),
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
                    queueMicrotask(() => subject.get({ ...input, targetWidth: 40 }));
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
