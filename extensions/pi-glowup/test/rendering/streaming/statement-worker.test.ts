import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import type { StatementResponse } from "../../../src/rendering/streaming/statement-worker.ts";

// Failure matrix: EOF ambiguity, partial lookahead tokens, ERROR/MISSING tails,
// unfinished nested suites, pipelines/heredocs, explicit unknown language, unicode.
const workers: Worker[] = [];
afterEach(async () => {
    await Promise.all(workers.splice(0).map(async (worker) => worker.terminate()));
});

async function parse(
    source: string,
    language: string,
    complete = false,
): Promise<StatementResponse> {
    const worker = new Worker(
        new URL("../../../src/rendering/streaming/statement-worker.ts", import.meta.url),
        { execArgv: [] },
    );
    workers.push(worker);

    return new Promise((resolve, reject) => {
        worker.once("error", reject);
        worker.once("message", resolve);
        worker.postMessage({ id: 1, source, language, complete });
    });
}

function ends(response: StatementResponse): number[] {
    if ("error" in response) throw new Error(response.error);
    return response.units.map((unit) => unit.end);
}

describe("real statement parser worker", () => {
    it("requires token lookahead rather than a successful EOF parse", async () => {
        expect(ends(await parse("fetch(x)", "javascript"))).toEqual([]);
        expect(ends(await parse("fetch(x)\n", "javascript"))).toEqual([]);
        expect(ends(await parse("fetch(x)\ni", "javascript"))).toEqual([]);
        expect(ends(await parse("fetch(x)\n.then(y)", "javascript"))).toEqual([]);
        expect(ends(await parse("fetch(x)\nnext(", "javascript"))).toContain(8);
        expect(ends(await parse("fetch(x);", "javascript"))).toEqual([9]);
    });

    it("reveals completed statements inside missing JS braces and Python suites", async () => {
        const js = "function f(){\nconst x=1;\nreturn x;\n";
        expect(ends(await parse(js, "javascript"))).toContain(js.indexOf("return") - 1);
        const python = "def f():\n    x=1\n    return";
        expect(ends(await parse(python, "python"))).toEqual([8, 16]);
    });

    it("does not publish malformed tails or incomplete pipelines", async () => {
        expect(ends(await parse("const x =", "typescript"))).toEqual([]);
        expect(ends(await parse("echo one |\n", "bash"))).toEqual([]);
        expect(ends(await parse("x=1\ny=", "python"))).toEqual([3]);
        const shell = "if true; then\n echo one\n echo two\n";
        expect(ends(await parse(shell, "bash"))).toEqual([]);
    });

    it("holds unfinished heredocs and boolean pipelines until their actual terminators", async () => {
        expect(ends(await parse("cat <<EOF\nhello\n", "bash"))).toEqual([]);
        expect(ends(await parse("cat <<EOF\nhello\nEOF\n", "bash"))).toEqual([19]);
        expect(ends(await parse("echo one &&\n", "bash"))).toEqual([]);
        expect(ends(await parse("echo one && echo two\n", "bash"))).toEqual([20]);
        expect(ends(await parse("type X = { x: number };", "typescript"))).toEqual([23]);
    });

    it("uses UTF-16 source offsets and holds explicit unknown languages", async () => {
        expect(ends(await parse('const x="😀";', "javascript"))).toEqual([13]);
        expect(ends(await parse("a; b;", "ruby"))).toEqual([]);
        expect(ends(await parse("a; b;", "ruby", true))).toEqual([5]);
    });
});
