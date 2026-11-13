import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
    createCommandScriptFormatter,
    parseScriptFormatterCommandsValue,
} from "../../../../src/tools/built-in/bash/formatter.ts";
import { createFormatterOutputStore } from "../../../../src/tools/built-in/bash/formatter-store.ts";

type Fixture = {
    readonly root: string;
    readonly store: string;
    readonly program: string;
    readonly runs: () => number;
};

function fixture(script = "tr a-z A-Z"): Fixture {
    const root = mkdtempSync(join(tmpdir(), "pi-glowup-formatter-store-"));
    onTestFinished(() => {
        chmodSync(root, 0o700);
        rmSync(root, { recursive: true, force: true });
    });
    const program = join(root, "upper");
    const counter = join(root, "runs");
    writeFileSync(counter, "");
    writeFileSync(program, `#!/bin/sh\necho run >> '${counter}'\n${script}\n`, { mode: 0o755 });

    return {
        root,
        store: join(root, "store"),
        program,
        runs: () => readFileSync(counter, "utf8").split("\n").filter(Boolean).length,
    };
}

function formatterFor(
    setup: Fixture,
    args: readonly string[] = [],
    reportWarning: (message: string) => void = () => {},
) {
    const formatter = createCommandScriptFormatter(
        parseScriptFormatterCommandsValue({
            python: { kind: "command", command: [setup.program, ...args] },
        }),
        reportWarning,
        createFormatterOutputStore(setup.store, reportWarning),
    );
    if (formatter === undefined) throw new Error("Expected a formatter");

    return formatter;
}

async function storedEntries(setup: Fixture, count: number): Promise<void> {
    await vi.waitUntil(
        () => {
            try {
                return (
                    readdirSync(setup.store).filter((name) => name.endsWith(".txt")).length >= count
                );
            } catch {
                return false;
            }
        },
        { timeout: 5_000 },
    );
}

const input = { label: "Python", language: "python", code: "print(value)" };

describe("formatter output store", () => {
    it("serves a later session from stored output without running the formatter", async () => {
        const setup = fixture();
        await expect(formatterFor(setup)(input)).resolves.toBe("PRINT(VALUE)");
        await storedEntries(setup, 1);

        await expect(formatterFor(setup)(input)).resolves.toBe("PRINT(VALUE)");
        expect(setup.runs()).toBe(1);
    });

    it("runs again when the profile arguments change", async () => {
        const setup = fixture();
        await formatterFor(setup)(input);
        await storedEntries(setup, 1);

        await formatterFor(setup, ["--other"])(input);
        expect(setup.runs()).toBe(2);
    });

    it("runs again when the formatter executable is replaced", async () => {
        const setup = fixture();
        await formatterFor(setup)(input);
        await storedEntries(setup, 1);

        const later = new Date(Date.now() + 60_000);
        utimesSync(setup.program, later, later);

        await formatterFor(setup)(input);
        expect(setup.runs()).toBe(2);
    });

    it("does not keep output from a formatter that rejected the source", async () => {
        const setup = fixture("exit 3");
        await expect(formatterFor(setup)(input)).resolves.toBeUndefined();

        await expect(formatterFor(setup)(input)).resolves.toBeUndefined();
        expect(setup.runs()).toBe(2);
    });

    it("keeps formatting and reports once when the store cannot be written", async () => {
        const setup = fixture();
        mkdirSync(setup.store);
        chmodSync(setup.store, 0o500);
        const warnings: string[] = [];
        const formatter = formatterFor(setup, [], (message) => {
            warnings.push(message);
        });

        await expect(formatter(input)).resolves.toBe("PRINT(VALUE)");
        await expect(formatter({ ...input, code: "print(other)" })).resolves.toBe("PRINT(OTHER)");
        await vi.waitUntil(() => warnings.length > 0, { timeout: 5_000 });

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("Formatter output cache is unavailable");
    });

    it("bounds the number of stored outputs", async () => {
        const setup = fixture();
        mkdirSync(setup.store);

        for (let index = 0; index < 2001; index += 1)
            writeFileSync(join(setup.store, `${String(index).padStart(64, "0")}.txt`), "old");

        await formatterFor(setup)(input);
        await vi.waitUntil(
            () => readdirSync(setup.store).filter((name) => name.endsWith(".txt")).length <= 1501,
            { timeout: 5_000 },
        );
    });
});
