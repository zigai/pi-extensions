import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
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
    const formatter = createCommandScriptFormatter(
        parseScriptFormatterCommandsValue({
            [language]: { kind: "command", command: [process.execPath, "-e", program] },
        }),
    );
    if (formatter === undefined) throw new Error("Invalid formatter");

    const store = createCodeStreamStore();
    stores.push(store);

    return { store, formatter, journal: () => readFileSync(log, "utf8") };
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
