import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { transform } from "esbuild";
import { stringParser } from "../../../src/json-scalar.ts";
import {
    createCodeStreamStore,
    type CodeStreamStore,
} from "../../../src/rendering/streaming/code-stream.ts";
import {
    createCommandScriptFormatter,
    parseScriptFormatterCommandsValue,
} from "../../../src/tools/built-in/bash/formatter.ts";

const stores: CodeStreamStore[] = [];
const directories: string[] = [];
afterEach(async () => {
    await Promise.all(stores.splice(0).map(async (store) => store.dispose()));

    for (const directory of directories.splice(0))
        rmSync(directory, { recursive: true, force: true });
});
function setup(language: string) {
    const directory = mkdtempSync(
        join(fileURLToPath(new URL("../../../.cache/", import.meta.url)), "structure-"),
    );
    directories.push(directory);
    const log = join(directory, "inputs.jsonl");
    const printer = `import(${JSON.stringify(import.meta.resolve("oxfmt"))}).then(async ({format})=>{const result=await format('unit.ts',code,{tabWidth:2,objectWrap:'collapse'});if(result.errors.length)process.exit(1);process.stdout.write(result.code);});`;
    const program = `const fs=require('node:fs');const code=fs.readFileSync(0,'utf8');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(code)+'\\n');${printer}`;
    const warnings: string[] = [];
    const formatter = createCommandScriptFormatter(
        parseScriptFormatterCommandsValue({
            [language]: { kind: "command", command: [process.execPath, "-e", program] },
        }),
        (message) => {
            warnings.push(message);
        },
    );
    if (formatter === undefined) throw new Error("Invalid formatter");

    const store = createCodeStreamStore();
    stores.push(store);

    return { store, formatter, warnings, journal: () => readFileSync(log, "utf8") };
}

it("formats JS/TS function, arrow, if and else headers once, before progressive reveal", async () => {
    const { store, formatter, journal } = setup("typescript");
    const source = "async function f(x:number){\n const g=(y:number)=>{\n if(y){\n return y+1;\n";
    const input = {
        key: "structure",
        source,
        language: "typescript",
        mode: "statement" as const,
        complete: false,
        formatter,
    };
    store.get(input);
    await store.settled();
    expect(store.get(input)).toBe(
        "async function f(x: number) {\n  const g = (y: number) => {\n    if (y) {\n      return y + 1;",
    );
    const before = journal();
    const final = {
        ...input,
        source: source + " }else{\n return 0;\n }\n };\n}\n",
        complete: true,
    };
    store.get(final);
    await store.settled();
    expect(store.get(final)).toBe(
        "async function f(x: number) {\n  const g = (y: number) => {\n    if (y) {\n      return y + 1;\n    } else {\n      return 0;\n    }\n  };\n}\n",
    );

    expect(journal().startsWith(before)).toBe(true);
    expect(journal().slice(before.length)).not.toContain("return y+1");
});

it("formats a streaming try header before its real handler without leaking the private handler", async () => {
    const { store, formatter, journal } = setup("typescript");
    const input = {
        key: "try",
        source: "try{\n const x=1;\n",
        language: "typescript",
        mode: "statement" as const,
        complete: false,
        formatter,
    };
    store.get(input);
    await store.settled();
    expect(store.get(input)).toBe("try {\n  const x = 1;");
    const before = journal();
    const final = {
        ...input,
        source: input.source + "}catch(error){\n report( error );\n}\n",
        complete: true,
    };
    store.get(final);
    await store.settled();
    expect(store.get(final)).toBe(
        "try {\n  const x = 1;\n} catch (error) {\n  report(error);\n}\n",
    );

    expect(journal().startsWith(before)).toBe(true);
    expect(journal().slice(before.length)).not.toContain("const x=1");
});

it("recovers nested class and try headers when an unfinished catch discards ancestor blocks", async () => {
    const { store, formatter, warnings, journal } = setup("typescript");
    const input = {
        key: "recovered-catch",
        source: "class Player {\n async run(signal:AbortSignal) {\n while(!signal.aborted) {\n try {\n await this.stream(signal);\n } catch(error) {\n if(signal.aborted) {\n",
        language: "typescript",
        mode: "statement" as const,
        complete: false,
        formatter,
    };
    store.get(input);
    await store.settled();
    expect(warnings).toEqual([]);
    expect(store.get(input)).toBe(
        "class Player {\n  async run(signal: AbortSignal) {\n    while (!signal.aborted) {\n      try {\n        await this.stream(signal);\n      }",
    );

    // Recovery must not turn a whole ERROR-node prefix into one synthetic header.
    const units: string[] = journal()
        .trim()
        .split("\n")
        .map((line: string) => {
            const value = stringParser.parse(JSON.parse(line));
            if (value === undefined) throw new Error("Invalid formatter journal entry");
            return value;
        });
    expect(units.some((unit) => unit.includes("try {\n//!"))).toBe(true);
    expect(units.every((unit) => !unit.includes("class Player {\n async run"))).toBe(true);
});

it.each([
    {
        name: "assigned anonymous function",
        source: "for(const value of [1]){try{target.handler=function(x){return x+1;};\n",
        expected:
            "for (const value of [1]) {\n  try {\n    target.handler = function (x) {\n      return x + 1;\n    }",
    },
    {
        name: "inline statements before try",
        source: "for(const value of [1]){const before=1;try{const result=2; consume({result:res",
        expected: "for (const value of [1]) {\n  const before = 1;\n  try {\n    const result = 2;",
    },
    {
        name: "callback call rather than class method",
        source: "for(const value of [1]){const lines=render();bench(name,()=>{invalidate();return render(",
        expected:
            "for (const value of [1]) {\n  const lines = render();\n  bench(name, () => {\n    invalidate();",
    },
])("formats recovered $name without invalid private scaffolding", async ({ source, expected }) => {
    const { store, formatter, warnings } = setup("typescript");
    const input = {
        key: "recovered-expression",
        source,
        language: "typescript",
        mode: "statement" as const,
        complete: false,
        formatter,
    };
    store.get(input);
    await store.settled();
    expect(warnings).toEqual([]);
    expect(store.get(input)).toBe(expected);
});

it.each(["Promise", "Promise<void>"])(
    "preserves constructor callback parentheses for %s during incremental reveal",
    async (constructor) => {
        const { store, formatter, warnings } = setup("typescript");
        const source = `async function run(){\n await new ${constructor}((resolve,reject)=>{\n ready(resolve,reject);\n });\n}\n`;
        const input = {
            key: "constructor-callback",
            source,
            language: "typescript",
            mode: "statement" as const,
            complete: false,
            formatter,
        };
        for (let end = 16; end < source.length; end += 16) {
            store.get({ ...input, source: source.slice(0, end) });
            await store.settled();
        }

        store.get({ ...input, complete: true });
        await store.settled();
        const display = store.get({ ...input, complete: true });
        expect(warnings).toEqual([]);
        expect(display).toContain(`await new ${constructor}((resolve, reject) => {`);
        const options = { loader: "ts" as const, minifyWhitespace: true };
        expect((await transform(display, options)).code).toBe(
            (await transform(source, options)).code,
        );
    },
);

it("formats class/method and unbraced conditional headers independently", async () => {
    const { store, formatter } = setup("typescript");
    const input = {
        key: "class",
        source: "class C{\n f(x:number){\n if(x) return x;\n else return 0;\n }\n}\n",
        language: "typescript",
        mode: "statement" as const,
        complete: true,
        formatter,
    };
    store.get(input);
    await store.settled();
    expect(store.get(input)).toBe(
        "class C {\n  f(x: number) {\n    if (x)\n      return x;\n    else\n      return 0;\n  }\n}\n",
    );
});

it("formats generator, derived constructor, super and private-field statements in ancestor skeletons", async () => {
    const { store, formatter } = setup("typescript");
    const input = {
        key: "contexts",
        source: "class Child extends Parent{\n #field=1;\n constructor(){\n super( 1 );\n }\n *items(){\n yield this.#field+1;\n }\n read(){\n return super.read()+this.#field;\n }\n}\n",
        language: "typescript",
        mode: "statement" as const,
        complete: true,
        formatter,
    };
    store.get(input);
    await store.settled();
    expect(store.get(input)).toBe(
        "class Child extends Parent {\n  #field = 1;\n  constructor() {\n    super(1);\n  }\n  *items() {\n    yield this.#field + 1;\n  }\n  read() {\n    return super.read() + this.#field;\n  }\n}\n",
    );
});

it("keeps generator and labelled-loop syntactic context without including preceding bodies", async () => {
    const { store, formatter, journal } = setup("typescript");
    const input = {
        key: "generator",
        source: "function* g(){\n yield 1+2;\n outer: for(let i=0;i<2;i++){\n continue outer;\n }\n}\n",
        language: "typescript",
        mode: "statement" as const,
        complete: true,
        formatter,
    };
    store.get(input);
    await store.settled();
    expect(store.get(input)).toBe(
        "function* g() {\n  yield 1 + 2;\n  outer: for (let i = 0; i < 2; i++) {\n    continue outer;\n  }\n}\n",
    );
    const inputs = journal().trim().split("\n");
    expect(
        inputs.some((line) => line.includes("yield 1+2") && line.includes("continue outer")),
    ).toBe(false);
});

it("formats switch and case headers independently of their completed bodies", async () => {
    const { store, formatter, journal } = setup("typescript");
    const input = {
        key: "switch",
        source: "switch(value){\n case 1+2:\n run( 1 );\n break;\n default:\n run( 0 );\n}\n",
        language: "typescript",
        mode: "statement" as const,
        complete: true,
        formatter,
    };
    store.get(input);
    await store.settled();
    expect(store.get(input)).toBe(
        "switch (value) {\n  case 1 + 2:\n    run(1);\n    break;\n  default:\n    run(0);\n}\n",
    );

    expect(
        journal()
            .trim()
            .split("\n")
            .some((line) => line.includes("run( 1 )") && line.includes("run( 0 )")),
    ).toBe(false);
});

it("formats private method and getter declarations without conflicting placeholder fields", async () => {
    const { store, formatter } = setup("typescript");
    const input = {
        key: "private",
        source: "class C{\n get #value(){\n return 1;\n }\n #read(){\n return this.#read()+this.#value;\n }\n read(){\n return this.#read();\n }\n}\n",
        language: "typescript",
        mode: "statement" as const,
        complete: true,
        formatter,
    };
    store.get(input);
    await store.settled();
    expect(store.get(input)).toBe(
        "class C {\n  get #value() {\n    return 1;\n  }\n  #read() {\n    return this.#read() + this.#value;\n  }\n  read() {\n    return this.#read();\n  }\n}\n",
    );
});

it("formats callback-expression headers with parser-derived private delimiter closings", async () => {
    const { store, formatter } = setup("typescript");
    const input = {
        key: "callback",
        source: "const result=items.map((x:number)=>{\n return x+1;\n",
        language: "typescript",
        mode: "statement" as const,
        complete: false,
        formatter,
    };
    store.get(input);
    await store.settled();
    expect(store.get(input)).toBe("const result = items.map((x: number) => {\n  return x + 1;");
    const final = { ...input, source: input.source + "});", complete: true };
    store.get(final);
    await store.settled();
    expect(store.get(final)).toBe(
        "const result = items.map((x: number) => {\n  return x + 1;\n});",
    );
});

it("never mistakes user strings or template lines for private wrapper sentinels", async () => {
    const { store, formatter } = setup("typescript");
    const input = {
        key: "literal",
        source: "function f(){\n return `first\n//! __glowup_unit_end__\nlast`;\n}\n",
        language: "typescript",
        mode: "statement" as const,
        complete: true,
        formatter,
    };
    store.get(input);
    await store.settled();
    expect(store.get(input)).toContain("last`;");
    expect(store.get(input)).toContain("//! __glowup_unit_end__");
});

it("keeps the full ready display during per-unit resize/profile replacement", async () => {
    const { store, formatter } = setup("typescript");
    const input = {
        key: "resize",
        source: "const x=1;\nconst y=2;",
        language: "typescript",
        mode: "statement" as const,
        complete: true,
        formatter,
    };
    store.get(input);
    await store.settled();
    const full = store.get(input);
    const observed: string[] = [];
    const resized = {
        ...input,
        targetWidth: 60,
        invalidate: () => {
            observed.push(store.get(resized));
        },
    };
    expect(store.get(resized)).toBe(full);
    expect(store.ready(input.key)).toBe(false);
    await store.settled();
    expect(observed).toEqual([full]);
    expect(store.ready(input.key)).toBe(true);
});

it("formats valid units before preserving a malformed final tail", async () => {
    const { store, formatter } = setup("typescript");
    const input = {
        key: "invalid",
        source: "const x=1;\nconst y=",
        language: "typescript",
        mode: "statement" as const,
        complete: true,
        formatter,
    };
    store.get(input);
    await store.settled();
    expect(store.get(input)).toBe("const x = 1;\nconst y=");
    expect(store.ready(input.key)).toBe(true);
});

it("notifies ready transitions for empty completed sources even without changed display", async () => {
    const { store, formatter } = setup("typescript");
    let invalidations = 0;
    const input = {
        key: "empty",
        source: "",
        language: "typescript",
        mode: "statement" as const,
        complete: true,
        formatter,
        invalidate: () => {
            invalidations += 1;
        },
    };
    store.get(input);
    expect(store.ready(input.key)).toBe(false);
    await store.settled();
    expect(store.ready(input.key)).toBe(true);
    expect(invalidations).toBe(1);
});
